// ADR 0009 Slice 2 — pull-filter security tests.
//
// These tests assert the load-bearing PII boundary: pending_invites
// rows MUST NOT appear in pulls served to non-OWNER_ROLES. The
// keyspaces machinery (`workers/src/replicache/keyspaces.ts`) is
// generally useful; the same shape will gate any future per-role
// hidden state (audit trails, owner-only annotations, etc.). A
// regression here is a PII leak — direct assertions, no
// fixture-derived sloppiness.
//
// Covers:
//   1. viewer never sees `pending_invites/*` keys
//   2. owner DOES see `pending_invites/*` keys
//   3. promotion (was-viewer, now-owner) emits invites as `put` ops
//   4. demotion (was-owner, now-viewer) emits `op:'del'` for
//      previously-cached invite keys (the eviction path)
//   5. revoke surfaces as `op:'del'` to a steady-state owner
//
// For broader testing conventions see `docs/testing.md`.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1, ReadonlyJSONObject } from 'replicache';

import { DjibbList, asLocalList } from '../src/list/durable_object';
import { IdTypes, newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makeInitListPush({
    clientGroupID,
    clientID,
    listId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                },
            },
        ],
    };
}

function makePush<TBody extends ReadonlyJSONObject>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
    accountId = null,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
    accountId?: string | null;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: mutationId,
                name,
                timestamp: Date.now(),
                args: {
                    accountId,
                    timestamp_client: new Date().toISOString(),
                    ...body,
                },
            },
        ],
    };
}

/**
 * Seed an entity with one pending invite, returning the listId and
 * inviter id. The push handler validates `envelope.accountId` against
 * `authorizedAccounts`, so the inviter is wired through both.
 */
async function seedListWithInvite({
    suffix,
    inviteeEmail = 'bob@example.com',
}: {
    suffix: string;
    inviteeEmail?: string;
}) {
    const { listId, stub } = getListStub(suffix);
    const clientGroupID = `cg_${suffix}`;
    const clientID = `c_${suffix}`;
    const inviterId = newId('account');

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
    });

    await stub.handlePush({
        authorizedAccounts: [{ id: inviterId } as any],
        authorizedRole: 'owner',
        listId,
        pushRequest: makePush({
            clientGroupID,
            clientID,
            name: 'inviteByIdentity',
            mutationId: 2,
            accountId: inviterId,
            body: {
                listId,
                identity_kind: 'email',
                identity_value: inviteeEmail,
                role: 'editor',
            },
        }),
    });

    return { listId, stub, clientGroupID, clientID, inviterId };
}

const INVITE_KEY_PREFIX = 'pending_invites/';

function hasInviteKey(patch: readonly unknown[], op?: 'put' | 'del'): boolean {
    return patch.some(entry => {
        const e = entry as { op: string; key?: string };
        if (op && e.op !== op) return false;
        return (
            typeof e.key === 'string' && e.key.startsWith(INVITE_KEY_PREFIX)
        );
    });
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('pull filter — PII gating', () => {
    it('viewer pull does NOT contain any pending_invites/* keys', async () => {
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_viewer',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'viewer',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        // The load-bearing assertion: not a single pending_invites/*
        // key in any patch op. If this regresses, viewer can see
        // invitee emails — a PII leak.
        expect(hasInviteKey(result.data!.patch)).toBe(false);

        // Entity itself IS in the patch (viewer can see the list).
        expect(
            result.data!.patch.some(
                e => e.op === 'put' && (e as any).key === listId
            )
        ).toBe(true);
    });

    it('editor pull does NOT contain any pending_invites/* keys', async () => {
        // EDIT_ROLES includes editor/checker; OWNER_ROLES does not.
        // Editors can mutate state but cannot see who's invited.
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_editor',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'editor',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();
        expect(hasInviteKey(result.data!.patch)).toBe(false);
    });

    it('owner pull DOES contain pending_invites/* keys as `put` ops', async () => {
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_owner',
            inviteeEmail: 'alice@example.com',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'owner',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        const putEntry = result.data!.patch.find(
            e =>
                e.op === 'put' &&
                (e as any).key === 'pending_invites/alice@example.com'
        );
        expect(putEntry).toBeDefined();
        if (putEntry?.op === 'put') {
            expect(putEntry.value).toMatchObject({
                identity_kind: 'email',
                identity_value: 'alice@example.com',
                role: 'editor',
            });
        }
    });
});

describe('pull filter — role transitions', () => {
    it('promotion: a viewer-cookie owner pull emits invites as fresh puts', async () => {
        // Set up: invite present at entity v2. Client previously
        // pulled as viewer at v=2 (so they never saw the invite).
        // They are now an owner — their next pull should include the
        // invite as a `put`, not as a v3 diff.
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_promo',
            inviteeEmail: 'carol@example.com',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'owner',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                // Previous pull was at v=2 as viewer. Without
                // promotion handling, the keyspace's `readChanges`
                // would query `version > 2` and miss the v=2 invite.
                cookie: { v: 2, r: 'viewer' },
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();
        expect(
            result.data!.patch.some(
                e =>
                    e.op === 'put' &&
                    (e as any).key === 'pending_invites/carol@example.com'
            )
        ).toBe(true);
    });

    it('demotion: a previously-owner viewer pull emits del for every cached invite key', async () => {
        // The eviction path. Owner cached the invite; their role got
        // dropped to viewer. Next pull MUST emit `op:'del'` so
        // Replicache evicts the keyspace from local cache.
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_demo',
            inviteeEmail: 'dave@example.com',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'viewer',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: { v: 2, r: 'owner' },
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        // del for the cached invite key.
        const delEntry = result.data!.patch.find(
            e =>
                e.op === 'del' &&
                (e as any).key === 'pending_invites/dave@example.com'
        );
        expect(delEntry).toBeDefined();

        // And no `put` ops for any invite key (the viewer must not
        // re-receive what they just lost access to).
        expect(hasInviteKey(result.data!.patch, 'put')).toBe(false);
    });
});

describe('pull filter — revoke surfaces as del', () => {
    it('steady-state owner sees `op:del` for a revoked invite', async () => {
        const { listId, stub, clientGroupID, clientID, inviterId } =
            await seedListWithInvite({
                suffix: 'pf_revoke',
                inviteeEmail: 'eve@example.com',
            });

        // Owner pulled at v=2 (saw the put). Now revoke.
        await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'revokeInvitation',
                mutationId: 3,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'eve@example.com',
                },
            }),
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'owner',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: { v: 2, r: 'owner' },
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        const delEntry = result.data!.patch.find(
            e =>
                e.op === 'del' &&
                (e as any).key === 'pending_invites/eve@example.com'
        );
        expect(delEntry).toBeDefined();
    });

    it('verifies DO row is tombstoned, not hard-deleted', async () => {
        // Direct DO sql inspection — the tombstone is what lets
        // `readChanges` surface the `del` op above. If revoke
        // ever regresses back to DELETE, this assertion breaks
        // before the del-op-not-emitted assertion does.
        const { stub, clientGroupID, clientID, inviterId, listId } =
            await seedListWithInvite({
                suffix: 'pf_tomb',
                inviteeEmail: 'frank@example.com',
            });

        await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'revokeInvitation',
                mutationId: 3,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'frank@example.com',
                },
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version FROM pending_invites
                     WHERE identity_value = 'frank@example.com';`
                )
                .one()
        );
        expect(row.time_deleted).not.toBeNull();
        expect(row.version).toBe(3);
    });
});

describe('pull filter — cookie shape', () => {
    it('response cookie is `{v, r}` with the current role', async () => {
        const { listId, stub, clientGroupID } = await seedListWithInvite({
            suffix: 'pf_cookie',
        });

        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'owner',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();
        expect(result.data!.cookie).toMatchObject({ v: 2, r: 'owner' });
    });
});
