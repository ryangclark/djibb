// ADR 0009 Slice 3: tests for `acceptInvitation` — the HTTP-boundary
// identity-match preflight, and the DO mutator's end-to-end behavior
// (promotes the acceptor, tombstones the pending row, flips the D1
// index row to `status='accepted'`).
//
// Two surfaces tested here:
//   1. `preflightAcceptInvitation` against a live D1 binding for the
//      identity-resolution + index-lookup paths.
//   2. `DjibbList.handlePush` round-trips for the mutator's end-state
//      (DO + D1) — mirrors the entityInvitations.test.ts shape.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import {
    GetInvitationFromIndex,
    preflightAcceptInvitation,
    type AcceptPreflightDeps,
} from '../src/list/invitations';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW_SECONDS = 1_700_000_000;

const acceptorAccountId = 'a/accept__aaaaaaaaaaaa';
const inviterAccountId = 'a/inviter_aaaaaaaaaaaa';
const acceptorEmail = 'invitee@example.com';
const targetListId = 'l/accept__aaaaaaaaaaaa';

function makeDeps(): AcceptPreflightDeps {
    const d1 = env.DJIBB_AUTH;
    return {
        getInvitationFromIndex: (targetId, kind, value) =>
            GetInvitationFromIndex(d1, {
                targetId,
                identity_kind: kind,
                identity_value: value,
            }),
    };
}

async function seedPendingIndexRow(opts: {
    targetId?: string;
    identityValue?: string;
    status?: 'pending' | 'accepted' | 'revoked';
    timeExpires?: number;
    role?: 'admin' | 'checker' | 'editor' | 'owner' | 'viewer';
}): Promise<void> {
    const targetId = opts.targetId ?? targetListId;
    const identityValue = opts.identityValue ?? acceptorEmail;
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO entity_invitations_index (
            id, target_id, target_type, identity_kind, identity_value,
            role, inviter_account_id, status, time_created, time_expires
         ) VALUES (?, ?, 'list', 'email', ?, ?, ?, ?, ?, ?)`
    )
        .bind(
            `inv/${identityValue.slice(0, 18).padEnd(18, 'x')}`,
            targetId,
            identityValue,
            opts.role ?? 'editor',
            inviterAccountId,
            opts.status ?? 'pending',
            NOW_SECONDS - 60,
            opts.timeExpires ?? NOW_SECONDS + 7 * 86400
        )
        .run();
}

describe('preflightAcceptInvitation', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    const verifiedAcceptor = {
        id: acceptorAccountId,
        email: acceptorEmail,
        email_verified: true,
    };

    it('passes for a verified identity match against a pending row', async () => {
        await seedPendingIndexRow({});
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [verifiedAcceptor],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.normalized_identity_value).toBe(acceptorEmail);
            expect(result.index_row.role).toBe('editor');
        }
    });

    it('rejects when no acceptor_account_id was supplied', async () => {
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: null,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.reason).toBe('unauthenticated_acceptor');
    });

    it('rejects when acceptor account is not in the session', async () => {
        await seedPendingIndexRow({});
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [
                { id: 'a/other___aaaaaaaaaaaa', email: 'x@y.z', email_verified: true },
            ],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('session_mismatch');
    });

    it("rejects when session account's email doesn't match the invitation", async () => {
        await seedPendingIndexRow({});
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [
                {
                    id: acceptorAccountId,
                    email: 'someone-else@example.com',
                    email_verified: true,
                },
            ],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('identity_unverified');
    });

    it('rejects when session email matches but email_verified is false', async () => {
        await seedPendingIndexRow({});
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [
                { ...verifiedAcceptor, email_verified: false },
            ],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('identity_unverified');
    });

    it('matches case-insensitively after normalization', async () => {
        await seedPendingIndexRow({});
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: '  INVITEE@Example.COM  ',
            sessionAccounts: [verifiedAcceptor],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(true);
    });

    it('rejects with invitation_not_found when no D1 row exists', async () => {
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [verifiedAcceptor],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invitation_not_found');
    });

    it('rejects when the D1 row is no longer pending (revoked / accepted)', async () => {
        await seedPendingIndexRow({ status: 'revoked' });
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [verifiedAcceptor],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invitation_not_pending');
    });

    it('rejects an expired invitation', async () => {
        await seedPendingIndexRow({ timeExpires: NOW_SECONDS - 1 });
        const result = await preflightAcceptInvitation(makeDeps(), {
            acceptor_account_id: acceptorAccountId,
            target_id: targetListId,
            identity_kind: 'email',
            identity_value: acceptorEmail,
            sessionAccounts: [verifiedAcceptor],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invitation_expired');
    });
});

// ------------------------------------------------------------------
// DO end-to-end: the mutator must promote the acceptor in the entity's
// authorization_rules, tombstone the DO pending_invites row, and flip
// the D1 index row to status='accepted'. We exercise this by directly
// calling handlePush on the DO stub (the HTTP boundary is unit-tested
// above; the DO is what makes the state changes durable).
// ------------------------------------------------------------------

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makePush<TBody extends Record<string, unknown>>({
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
                } as any,
            },
        ],
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
                } as any,
            },
        ],
    };
}

describe('acceptInvitation (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('promotes the acceptor, tombstones the invite, and flips D1 to accepted', async () => {
        const { listId, stub } = getListStub('acc1');
        const clientGroupID = 'cg_acc_1';
        const clientID = 'c_acc_1';
        const inviterId = newId('account');
        const accepterId = newId('account');
        const email = 'bob@example.com';

        // Init then invite.
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
                    identity_value: email,
                    role: 'editor',
                },
            }),
        });

        // Accept — from a session whose accountId differs (the invitee
        // is `restricted` against the entity's rules until commit).
        // The acceptor's session account must carry a verified email
        // matching the invite (the in-DO preflight checks identity
        // ownership, ADR 0009 Slice 3 redo).
        const result = await stub.handlePush({
            authorizedAccounts: [
                {
                    id: accepterId,
                    email,
                    email_verified: true,
                } as any,
            ],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                clientGroupID: 'cg_accepter',
                clientID: 'c_accepter',
                name: 'acceptInvitation',
                mutationId: 1,
                accountId: accepterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: email,
                },
            }),
        });
        expect(result.error).toBeNull();

        // DO: pending_invites row is tombstoned (time_deleted set).
        const inviteRow = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT identity_value, time_deleted FROM pending_invites
                     WHERE identity_value = ?;`,
                    email
                )
                .one()
        );
        expect(inviteRow.time_deleted).not.toBeNull();

        // DO: list_elements row has acceptor in authorized_accounts.
        const listRow = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT authorization_rules FROM list_elements
                     WHERE id = ?;`,
                    listId
                )
                .one()
        );
        const rules = JSON.parse(listRow.authorization_rules as string);
        expect(rules.authorized_accounts[accepterId]).toEqual({
            role: 'editor',
        });

        // D1 index: row is status='accepted' (NOT revoked, even though
        // the DO row is now tombstoned — the accept emit beat the
        // reconciler).
        const d1Row = await env.DJIBB_AUTH.prepare(
            `SELECT status FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .first<{ status: string }>();
        expect(d1Row?.status).toBe('accepted');
    });

    it('preflight skip-and-acks when the acceptor email does not match the invite', async () => {
        // ADR 0009 Slice 3 redo — the in-DO preflight runs identity-
        // ownership verification. A session whose verified email
        // doesn't match the invitation's identity must NOT promote
        // itself by pushing acceptInvitation. The push completes
        // (no error escapes the DO; lastMutationID advances), but
        // no rules update or invite tombstone happens.
        const { listId, stub } = getListStub('acc3');
        const clientGroupID = 'cg_acc_3';
        const clientID = 'c_acc_3';
        const inviterId = newId('account');
        const wrongAcceptorId = newId('account');
        const inviteEmail = 'real-invitee@example.com';

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
                    identity_value: inviteEmail,
                    role: 'editor',
                },
            }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [
                {
                    id: wrongAcceptorId,
                    email: 'different@example.com',
                    email_verified: true,
                } as any,
            ],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                clientGroupID: 'cg_wrong_acceptor',
                clientID: 'c_wrong_acceptor',
                name: 'acceptInvitation',
                mutationId: 1,
                accountId: wrongAcceptorId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: inviteEmail,
                },
            }),
        });
        expect(result.error).toBeNull();

        // Rules unchanged — wrong acceptor was NOT added.
        const listRow = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT authorization_rules FROM list_elements
                     WHERE id = ?;`,
                    listId
                )
                .one()
        );
        const rules = JSON.parse(listRow.authorization_rules as string);
        expect(rules.authorized_accounts[wrongAcceptorId]).toBeUndefined();

        // Pending invite is still live (not tombstoned by the failed
        // accept).
        const liveInvite = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT identity_value, time_deleted FROM pending_invites
                     WHERE time_deleted IS NULL;`
                )
                .one()
        );
        expect(liveInvite.identity_value).toBe(inviteEmail);

        // D1 row still pending (not flipped to accepted).
        const d1Row = await env.DJIBB_AUTH.prepare(
            `SELECT status FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .first<{ status: string }>();
        expect(d1Row?.status).toBe('pending');
    });

    it('returns `gone` when no pending invite exists', async () => {
        const { listId, stub } = getListStub('acc2');
        const clientGroupID = 'cg_acc_2';
        const clientID = 'c_acc_2';
        const accepterId = newId('account');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: accepterId } as any],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                clientGroupID: 'cg_acc_2b',
                clientID: 'c_acc_2b',
                name: 'acceptInvitation',
                mutationId: 1,
                accountId: accepterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'no-such@example.com',
                },
            }),
        });
        // Server returns gone — no error escapes the DO, the push
        // succeeds with no mutation.
        expect(result.error).toBeNull();
        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT authorization_rules FROM list_elements
                     WHERE id = ?;`,
                    listId
                )
                .one()
        );
        const rules = JSON.parse(row.authorization_rules as string);
        expect(rules.authorized_accounts[accepterId]).toBeUndefined();
    });
});
