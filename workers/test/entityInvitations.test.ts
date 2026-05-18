// Substrate tests for ADR 0009 entity-only invitations (Slice 1).
//
// Covers the `inviteByIdentity` and `revokeInvitation` mutator pair:
// DO-side `pending_invites` writes, post-commit emit to the D1
// `entity_invitations_index`, role-gating, identity normalization,
// idempotency, and revoke-marks-D1-revoked reconciliation.
//
// The pull-filter (Slice 2) and the accept mutator (Slice 3) are out
// of scope here. Direct DO sql inspection + direct D1 queries are
// sufficient to exercise the substrate without depending on either.
//
// For broader testing conventions (dev seams, pure predicates, the
// E2E surface) see `docs/testing.md`.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
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
                },
            },
        ],
    };
}

/**
 * Init the entity and seed its `authorization_rules` so a specific
 * test account holds the `owner` role. The DO push handler routes
 * `authorizedRole` from the request rather than re-deriving from the
 * row, so we don't actually need to mutate the row for the gate to
 * pass — but we do need to call `setListAuthRules` for realism in
 * scenarios that later read the row.
 */
async function initEntity({
    stub,
    listId,
    clientGroupID,
    clientID,
}: {
    stub: DurableObjectStub<DjibbList>;
    listId: string;
    clientGroupID: string;
    clientID: string;
}) {
    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
    });
}

describe('inviteByIdentity', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('inserts a pending invite into the DO and emits a pending row to D1', async () => {
        const { listId, stub } = getListStub('inv1');
        const clientGroupID = 'cg_inv_1';
        const clientID = 'c_inv_1';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        const result = await stub.handlePush({
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
                    identity_value: 'Bob@Example.com',
                    role: 'editor',
                },
            }),
        });
        expect(result.error).toBeNull();

        // DO row: lowercased value, owner-supplied role, version=2.
        const doRow = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT identity_kind, identity_value, role,
                            inviter_account_id, version
                     FROM pending_invites;`
                )
                .one()
        );
        expect(doRow.identity_value).toBe('bob@example.com');
        expect(doRow.role).toBe('editor');
        expect(doRow.inviter_account_id).toBe(inviterId);
        expect(doRow.version).toBe(2);

        // D1 index: a row was emitted as status='pending'.
        const d1Row = await env.DJIBB_AUTH.prepare(
            `SELECT target_id, target_type, identity_kind, identity_value,
                    role, inviter_account_id, status
             FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .first<any>();
        expect(d1Row).not.toBeNull();
        expect(d1Row.identity_value).toBe('bob@example.com');
        expect(d1Row.status).toBe('pending');
        expect(d1Row.target_type).toBe('list');
        expect(d1Row.role).toBe('editor');
    });

    it('rejects editor role (OWNER_ROLES only)', async () => {
        const { listId, stub } = getListStub('inv2');
        const clientGroupID = 'cg_inv_2';
        const clientID = 'c_inv_2';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            // editor is in EDIT_ROLES but NOT in OWNER_ROLES.
            authorizedRole: 'editor',
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
                    identity_value: 'bob@example.com',
                    role: 'editor',
                },
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);

        // No DO row, no D1 row.
        const doCount = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT COUNT(*) AS c FROM pending_invites;`)
                .one()
        );
        expect(doCount.c).toBe(0);

        const d1Row = await env.DJIBB_AUTH.prepare(
            `SELECT id FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .first();
        expect(d1Row).toBeNull();
    });

    it('returns stale on duplicate invite for the same (kind, value)', async () => {
        const { listId, stub } = getListStub('inv3');
        const clientGroupID = 'cg_inv_3';
        const clientID = 'c_inv_3';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        // First invite — applied.
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
                    identity_value: 'bob@example.com',
                    role: 'editor',
                },
            }),
        });

        // Second invite — same identity, different role. Server
        // returns `{status:'stale'}`, no second DO row, original role
        // preserved.
        const second = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'inviteByIdentity',
                mutationId: 3,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'BOB@example.com', // case-variant
                    role: 'viewer', // would-be different role
                },
            }),
        });
        expect(second.error).toBeNull();

        const doRows = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT identity_value, role FROM pending_invites;`)
                .toArray()
        );
        expect(doRows).toHaveLength(1);
        expect(doRows[0].role).toBe('editor'); // unchanged
    });

    // ------------------------------------------------------------------
    // ADR 0009 Slice 3 redo: in-DO preflight. Verifies the preflight
    // runs inside `_handlePush` before the synchronous mutator, and
    // that failures skip-and-ack rather than throwing — the push
    // completes successfully at the HTTP layer, the mutation log
    // records the skip, and the per-mutation outcome flows over the
    // WS channel (not exercised here; WS roundtrip tests live in
    // outcomeChannel.test.ts).
    // ------------------------------------------------------------------

    it('preflight skip-and-acks when the target is already a member', async () => {
        const { listId, stub } = getListStub('inv5');
        const clientGroupID = 'cg_inv_5';
        const clientID = 'c_inv_5';
        const inviterId = newId('account');
        const targetId = newId('account');
        const targetEmail = 'already@example.com';

        await initEntity({ stub, listId, clientGroupID, clientID });

        // Seed the target as already a member of the entity. We do
        // this by directly inserting into the DO's list_elements (via
        // a setListAuthRules mutation) so the preflight's
        // `authorization_rules.authorized_accounts` lookup hits.
        await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'setListAuthRules',
                mutationId: 2,
                accountId: inviterId,
                body: {
                    listId,
                    authorization_rules: {
                        authorized_accounts: {
                            [inviterId]: { role: 'owner' },
                            [targetId]: { role: 'editor' },
                        },
                        default_role: 'restricted',
                        set_by: 'user',
                    },
                },
            }),
        });

        // Seed an `accounts` row so the preflight's email→account
        // resolver returns `targetId`.
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO accounts (
                id, display_name, email, email_verified, provider_name,
                provider_client_id, time_created, time_updated
             ) VALUES (?, 'Target', ?, 1, 'djibb', ?, ?, ?)`
        )
            .bind(
                targetId,
                targetEmail,
                `client_${targetId}`,
                Math.floor(Date.now() / 1000),
                Math.floor(Date.now() / 1000)
            )
            .run();

        // Invite the already-member. The preflight should skip-and-ack;
        // the push completes (no error) but no pending_invite row is
        // created.
        const inviteResult = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'inviteByIdentity',
                mutationId: 3,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: targetEmail,
                    role: 'editor',
                },
            }),
        });
        expect(inviteResult.error).toBeNull();

        // No DO pending_invite row exists.
        const doCount = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT COUNT(*) AS c FROM pending_invites;`)
                .one()
        );
        expect(doCount.c).toBe(0);

        // No D1 row either — the index reconciler never ran because
        // didMutate stayed false.
        const d1Row = await env.DJIBB_AUTH.prepare(
            `SELECT id FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .first();
        expect(d1Row).toBeNull();

        // A subsequent push from the same client with mutation.id=4
        // is processed as expected — confirms the skipped mutation was
        // ACKed (lastMutationID advanced past 3).
        const followUp = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'inviteByIdentity',
                mutationId: 4,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'stranger@example.com',
                    role: 'editor',
                },
            }),
        });
        expect(followUp.error).toBeNull();
        const afterCount = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT COUNT(*) AS c FROM pending_invites;`)
                .one()
        );
        expect(afterCount.c).toBe(1); // stranger@ landed; already-member skipped
    });

    // ------------------------------------------------------------------
    // ADR 0009 §"Email send": a successful inviteByIdentity fires a
    // notification email to the invitee. Best-effort; failures don't
    // affect the push response.
    // ------------------------------------------------------------------

    it('fires a notification email after a successful inviteByIdentity', async () => {
        const { listId, stub } = getListStub('invemail');
        const clientGroupID = 'cg_inv_email';
        const clientID = 'c_inv_email';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        // Stub env.EMAIL.send with a spy. Restore on the way out so a
        // later test doesn't see lingering captures (vitest isolates
        // modules per-file but `env` is per-test-file singleton).
        const sends: Array<Record<string, unknown>> = [];
        const originalEmail = (env as { EMAIL?: unknown }).EMAIL;
        (env as { EMAIL: unknown }).EMAIL = {
            send: async (msg: Record<string, unknown>) => {
                sends.push(msg);
            },
        };

        try {
            const result = await stub.handlePush({
                authorizedAccounts: [
                    {
                        id: inviterId,
                        display_name: 'Alice Inviter',
                    } as any,
                ],
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
                        identity_value: 'Recipient@Example.com',
                        role: 'editor',
                    },
                }),
            });
            expect(result.error).toBeNull();

            // One send, addressed to the normalized (lower-cased) email
            // the DO stored — matches the D1 index row.
            expect(sends).toHaveLength(1);
            const sent = sends[0]!;
            expect(sent.to).toBe('recipient@example.com');
            // Subject mentions the inviter's display_name (taken from
            // authorizedAccounts) and the inviting verb. Entity has no
            // name yet (init didn't set one) so the subject phrasing
            // falls back to "a list".
            expect(String(sent.subject)).toContain('Alice Inviter');
            expect(String(sent.subject)).toMatch(/djibb/i);
            // Body links to the entity URL with the from_invite hint —
            // the deferred banner picks this up.
            const html = String(sent.html);
            expect(html).toContain('from_invite=1');
            // Suffix from `l/<suffix>` rather than the whole id (URL
            // form strips the type-prefix segment).
            const idSuffix = listId.split('/')[1];
            expect(html).toContain(`/l/${idSuffix}`);
        } finally {
            (env as { EMAIL: unknown }).EMAIL = originalEmail;
        }
    });

    it('skips email send for preflight-failed invites (already_member)', async () => {
        const { listId, stub } = getListStub('invemail2');
        const clientGroupID = 'cg_inv_email2';
        const clientID = 'c_inv_email2';
        const inviterId = newId('account');
        const targetId = newId('account');
        const targetEmail = 'member@example.com';

        await initEntity({ stub, listId, clientGroupID, clientID });

        // Seed target as already a member via setListAuthRules so the
        // preflight rejects the invite. (Mirrors the existing already_
        // member preflight test above.)
        await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'setListAuthRules',
                mutationId: 2,
                accountId: inviterId,
                body: {
                    listId,
                    authorization_rules: {
                        authorized_accounts: {
                            [inviterId]: { role: 'owner' },
                            [targetId]: { role: 'editor' },
                        },
                        default_role: 'restricted',
                        set_by: 'user',
                    },
                },
            }),
        });
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO accounts (
                id, display_name, email, email_verified, provider_name,
                provider_client_id, time_created, time_updated
             ) VALUES (?, 'Member', ?, 1, 'djibb', ?, ?, ?)`
        )
            .bind(
                targetId,
                targetEmail,
                `client_${targetId}`,
                Math.floor(Date.now() / 1000),
                Math.floor(Date.now() / 1000)
            )
            .run();

        const sends: Array<unknown> = [];
        const originalEmail = (env as { EMAIL?: unknown }).EMAIL;
        (env as { EMAIL: unknown }).EMAIL = {
            send: async (msg: unknown) => {
                sends.push(msg);
            },
        };

        try {
            const result = await stub.handlePush({
                authorizedAccounts: [
                    { id: inviterId, display_name: 'Alice' } as any,
                ],
                authorizedRole: 'owner',
                listId,
                pushRequest: makePush({
                    clientGroupID,
                    clientID,
                    name: 'inviteByIdentity',
                    mutationId: 3,
                    accountId: inviterId,
                    body: {
                        listId,
                        identity_kind: 'email',
                        identity_value: targetEmail,
                        role: 'editor',
                    },
                }),
            });
            expect(result.error).toBeNull();
            // Preflight blocked the mutation; no email should have
            // fired. (Counted alongside the existing test that asserts
            // no DO/D1 row was created.)
            expect(sends).toHaveLength(0);
        } finally {
            (env as { EMAIL: unknown }).EMAIL = originalEmail;
        }
    });
});

describe('revokeInvitation', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('tombstones the DO row and marks the D1 row revoked', async () => {
        const { listId, stub } = getListStub('rev1');
        const clientGroupID = 'cg_rev_1';
        const clientID = 'c_rev_1';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        // Invite, then revoke.
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
                    identity_value: 'bob@example.com',
                    role: 'editor',
                },
            }),
        });

        const revokeResult = await stub.handlePush({
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
                    identity_value: 'Bob@example.com', // case-variant resolves
                },
            }),
        });
        expect(revokeResult.error).toBeNull();

        // DO: ADR 0009 Slice 2 — revoke is soft-delete. The row
        // survives with `time_deleted` set and `version` bumped so the
        // pull keyspace can surface `op:'del'` to clients that had
        // previously cached it.
        const tombstone = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version FROM pending_invites;`
                )
                .one()
        );
        expect(tombstone.time_deleted).not.toBeNull();
        expect(tombstone.version).toBe(3);

        // The active set (filtered by time_deleted IS NULL) is empty.
        const liveCount = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT COUNT(*) AS c FROM pending_invites
                     WHERE time_deleted IS NULL;`
                )
                .one()
        );
        expect(liveCount.c).toBe(0);

        // D1: row is retained as audit, status flipped to revoked.
        const d1Rows = await env.DJIBB_AUTH.prepare(
            `SELECT status FROM entity_invitations_index WHERE target_id = ?`
        )
            .bind(listId)
            .all<{ status: string }>();
        expect(d1Rows.results).toHaveLength(1);
        expect(d1Rows.results![0].status).toBe('revoked');
    });

    it('returns gone when revoking a non-existent invite', async () => {
        const { listId, stub } = getListStub('rev2');
        const clientGroupID = 'cg_rev_2';
        const clientID = 'c_rev_2';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'revokeInvitation',
                mutationId: 2,
                accountId: inviterId,
                body: {
                    listId,
                    identity_kind: 'email',
                    identity_value: 'nobody@example.com',
                },
            }),
        });
        // The push itself doesn't error — the mutator returns
        // {status:'gone'} which surfaces as a no-op (per ADR 0005).
        expect(result.error).toBeNull();
    });

    it('rejects editor role (OWNER_ROLES only)', async () => {
        const { listId, stub } = getListStub('rev3');
        const clientGroupID = 'cg_rev_3';
        const clientID = 'c_rev_3';
        const inviterId = newId('account');

        await initEntity({ stub, listId, clientGroupID, clientID });

        // Seed an invite as owner first.
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
                    identity_value: 'bob@example.com',
                    role: 'editor',
                },
            }),
        });

        const revokeResult = await stub.handlePush({
            authorizedAccounts: [{ id: inviterId } as any],
            authorizedRole: 'editor',
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
                    identity_value: 'bob@example.com',
                },
            }),
        });
        expect(revokeResult.error).not.toBeNull();
        expect(revokeResult.error?.name).toMatch(/Unauthorized/i);

        // Invite still present in both DO and D1 (live, not tombstoned).
        const doCount = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT COUNT(*) AS c FROM pending_invites
                     WHERE time_deleted IS NULL;`
                )
                .one()
        );
        expect(doCount.c).toBe(1);
    });
});
