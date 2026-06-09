// ADR 0011 §Phase 5: tests for `moveList` — moving a list between
// workspaces. Two surfaces:
//   1. `DjibbList.handlePush` round-trips for the mutator's end-state
//      (DO sql `list_elements.workspace_id` + version bump). Because
//      `moveList` is a PREFLIGHTED mutator, these also exercise the
//      push-boundary preflight: the actor must be a member of the
//      destination workspace (seeded into `entity_memberships`).
//   2. `preflightMoveList` in isolation — unit tests with stubbed deps
//      for each failure reason, plus one round-trip against the real D1
//      binding (`GetMembership` / `GetEntityVersion`).

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import {
    preflightMoveList,
    inverse as moveListInverse,
    name as moveListName,
    type MovePreflightDeps,
} from '../src/list/mutators/moveList';
import { GetMembership } from '../src/workspace/service';
import { GetEntityVersion } from '../src/list/entity';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW_SECONDS = 1_700_000_000;

// ---------- Helpers (DO round-trip pattern; mirrors transferOwnership.test.ts) ----------

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
    accountId,
    workspaceId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    accountId: string;
    workspaceId: string | null;
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
                    accountId,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId,
                } as any,
            },
        ],
    };
}

/** Read `{ workspace_id, version }` off the DO entity row, or null. */
async function readEntity(stub: DurableObjectStub<DjibbList>, listId: string) {
    return runInDurableObject(stub, async (_i, state) => {
        const rows = state.storage.sql
            .exec(
                `SELECT workspace_id, version FROM list_elements WHERE id = ?;`,
                listId
            )
            .toArray();
        const row = rows[0];
        if (!row) return null;
        return {
            workspace_id: (row.workspace_id as string | null) ?? null,
            version: row.version as number,
        };
    });
}

async function seedMembership(
    accountId: string,
    entityId: string,
    role = 'admin'
): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO entity_memberships (account_id, entity_id, role, time_updated)
         VALUES (?, ?, ?, ?)`
    )
        .bind(accountId, entityId, role, NOW_SECONDS)
        .run();
}

async function seedWorkspaceEntity(id: string): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO workspace_entities
            (id, workspace_id, type, name, description, forked_from_id,
             meta, slug, slot, authorization_rules, time_created,
             time_updated, time_deleted, version)
         VALUES (?, NULL, 'workspace', 'seed', NULL, NULL, NULL, ?, NULL,
             '{}', ?, ?, NULL, 1)`
    )
        .bind(id, id.slice(2), NOW_SECONDS, NOW_SECONDS)
        .run();
}

// ---------- moveList (DO mutator + wired preflight) ----------

describe('moveList (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('updates workspace_id and bumps version', async () => {
        const { listId, stub } = getListStub('move1');
        const clientGroupID = 'cg_move_1';
        const clientID = 'c_move_1';
        const owner = newId('account');
        const w1 = newId('workspace');
        const w2 = newId('workspace');

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: owner,
                workspaceId: w1,
            }),
        });

        const before = await readEntity(stub, listId);
        expect(before?.workspace_id).toBe(w1);

        // Actor must be a member of the destination for the preflight to pass.
        await seedMembership(owner, w2);

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'moveList',
                mutationId: 2,
                accountId: owner,
                body: { listId, workspace_id: w2 },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readEntity(stub, listId);
        expect(after?.workspace_id).toBe(w2);
        expect(after!.version).toBeGreaterThan(before!.version);
    });

    it('is an idempotent no-op when target === current', async () => {
        const { listId, stub } = getListStub('move2');
        const clientGroupID = 'cg_move_2';
        const clientID = 'c_move_2';
        const owner = newId('account');
        const w1 = newId('workspace');

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: owner,
                workspaceId: w1,
            }),
        });

        await seedMembership(owner, w1);

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'moveList',
                mutationId: 2,
                accountId: owner,
                body: { listId, workspace_id: w1 },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readEntity(stub, listId);
        expect(after?.workspace_id).toBe(w1);
    });

    it('does not create a row for a missing entity (gone)', async () => {
        const { listId, stub } = getListStub('move3');
        const owner = newId('account');
        const w2 = newId('workspace');

        // No init: the entity row never exists. Seed the membership so
        // the preflight passes and the synchronous mutator gets to run
        // and surface its own `gone` outcome.
        await seedMembership(owner, w2);

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID: 'cg_move_3',
                clientID: 'c_move_3',
                name: 'moveList',
                mutationId: 1,
                accountId: owner,
                body: { listId, workspace_id: w2 },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readEntity(stub, listId);
        expect(after).toBeNull();
    });

    it('rejects via preflight when actor is not a member of the destination', async () => {
        const { listId, stub } = getListStub('move4');
        const clientGroupID = 'cg_move_4';
        const clientID = 'c_move_4';
        const owner = newId('account');
        const w1 = newId('workspace');
        const w2 = newId('workspace');

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: owner,
                workspaceId: w1,
            }),
        });

        // Destination exists but the actor is NOT a member of it.
        await seedWorkspaceEntity(w2);

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'moveList',
                mutationId: 2,
                accountId: owner,
                body: { listId, workspace_id: w2 },
            }),
        });
        // Preflight skip-and-acks: the push succeeds at the HTTP layer.
        expect(result.error).toBeNull();

        // …but the move did NOT happen: still in the source workspace.
        const after = await readEntity(stub, listId);
        expect(after?.workspace_id).toBe(w1);
    });

    it('inverse round-trips back to the prior workspace_id', async () => {
        const { listId, stub } = getListStub('move5');
        const clientGroupID = 'cg_move_5';
        const clientID = 'c_move_5';
        const owner = newId('account');
        const w1 = newId('workspace');
        const w2 = newId('workspace');

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: owner,
                workspaceId: w1,
            }),
        });

        await seedMembership(owner, w1);
        await seedMembership(owner, w2);

        // Forward move w1 → w2.
        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'moveList',
                mutationId: 2,
                accountId: owner,
                body: { listId, workspace_id: w2 },
            }),
        });
        expect((await readEntity(stub, listId))?.workspace_id).toBe(w2);

        // Compute the inverse and apply it.
        const inv = moveListInverse(
            { listId, workspace_id: w2 },
            { workspace_id: w1 }
        );
        expect(inv).not.toBeNull();
        expect(inv!.name).toBe(moveListName);

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: moveListName,
                mutationId: 3,
                accountId: owner,
                body: inv!.args as Record<string, unknown>,
            }),
        });

        const after = await readEntity(stub, listId);
        expect(after?.workspace_id).toBe(w1);
    });
});

// ---------- moveList inverse (pure) ----------

describe('moveList inverse (pure)', () => {
    it('returns a CAS-guarded move back to the prior workspace', () => {
        const inv = moveListInverse(
            { listId: 'l/x', workspace_id: 'w/new' },
            { workspace_id: 'w/old' }
        );
        expect(inv).toEqual({
            name: 'moveList',
            args: {
                listId: 'l/x',
                workspace_id: 'w/old',
                expected: { workspace_id: 'w/new' },
            },
        });
    });

    it('returns null when there is no prior workspace_id to restore', () => {
        expect(
            moveListInverse({ listId: 'l/x', workspace_id: 'w/new' }, {})
        ).toBeNull();
        expect(
            moveListInverse(
                { listId: 'l/x', workspace_id: 'w/new' },
                { workspace_id: null }
            )
        ).toBeNull();
    });
});

// ---------- preflightMoveList (stubbed deps) ----------

describe('preflightMoveList (unit)', () => {
    const actor = 'a/actor___aaaaaaaaaaaa';
    const target = newId('workspace');

    function deps(over: Partial<MovePreflightDeps> = {}): MovePreflightDeps {
        return {
            getMembership: async () => null,
            targetWorkspaceExists: async () => true,
            ...over,
        };
    }

    it('rejects an unauthenticated actor', async () => {
        const result = await preflightMoveList(deps(), {
            actor_account_id: null,
            target_workspace_id: target,
            sessionAccountIds: [],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('unauthenticated_actor');
    });

    it('rejects an actor not in the current session', async () => {
        const result = await preflightMoveList(deps(), {
            actor_account_id: actor,
            target_workspace_id: target,
            sessionAccountIds: ['a/other___aaaaaaaaaaaa'],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('unauthenticated_actor');
    });

    it('passes when the actor is a member of the destination', async () => {
        const result = await preflightMoveList(
            deps({ getMembership: async () => ({ role: 'editor' }) }),
            {
                actor_account_id: actor,
                target_workspace_id: target,
                sessionAccountIds: [actor],
            }
        );
        expect(result).toEqual({ ok: true });
    });

    it('rejects a non-member of an existing destination', async () => {
        const result = await preflightMoveList(
            deps({
                getMembership: async () => null,
                targetWorkspaceExists: async () => true,
            }),
            {
                actor_account_id: actor,
                target_workspace_id: target,
                sessionAccountIds: [actor],
            }
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_target_member');
    });

    it('reports a missing destination distinctly', async () => {
        const result = await preflightMoveList(
            deps({
                getMembership: async () => null,
                targetWorkspaceExists: async () => false,
            }),
            {
                actor_account_id: actor,
                target_workspace_id: target,
                sessionAccountIds: [actor],
            }
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('target_missing');
    });
});

// ---------- preflightMoveList (real D1) ----------

describe('preflightMoveList (real D1 binding)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    function realDeps(): MovePreflightDeps {
        const d1 = env.DJIBB_AUTH;
        return {
            getMembership: (a, w) => GetMembership(d1, a, w),
            targetWorkspaceExists: async w =>
                (await GetEntityVersion(d1, w)) !== null,
        };
    }

    it('passes for a member and rejects a non-member', async () => {
        const member = newId('account');
        const stranger = newId('account');
        const target = newId('workspace');

        await seedWorkspaceEntity(target);
        await seedMembership(member, target, 'admin');

        const ok = await preflightMoveList(realDeps(), {
            actor_account_id: member,
            target_workspace_id: target,
            sessionAccountIds: [member],
        });
        expect(ok).toEqual({ ok: true });

        const denied = await preflightMoveList(realDeps(), {
            actor_account_id: stranger,
            target_workspace_id: target,
            sessionAccountIds: [stranger],
        });
        expect(denied.ok).toBe(false);
        if (!denied.ok) expect(denied.reason).toBe('not_target_member');
    });
});
