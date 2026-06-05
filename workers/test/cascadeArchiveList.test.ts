// ADR 0011 §Step 10a.4a / ADR 0008: tests for the `cascadeArchiveList`
// mutator — the system-only sibling of `archiveList` invoked by the
// Workspace DO during cascade-archive sweeps.
//
// The handler in 10a.4b is what actually wires this up to a Workspace
// deletion; here we cover the mutator-level invariants in isolation:
//
//   1. shape — name, requiredRole, inverse, argsSchema bounds
//   2. behavior — handlePush with `authorizedRole: 'system'` writes
//      `time_deleted` AND `cascade_source` on the entity row
//   3. role gating — non-system roles are refused at dispatch (the
//      registry's `requiredRole` check), even when args are valid
//   4. projection — the post-commit emit threads `cascade_source`
//      into the D1 `workspace_entities` row

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { ID_LENGTH, IdTypes } from '../src/id';
import * as cascadeArchiveList from '../src/list/mutators/cascadeArchiveList';
import { SYSTEM_ROLES } from '../src/list/mutators/_shared';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(ID_LENGTH, 'a').slice(0, ID_LENGTH)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makeWorkspaceId(suffix: string): string {
    return `${IdTypes.workspace}/${suffix.padEnd(ID_LENGTH, 'a').slice(0, ID_LENGTH)}`;
}

function makePush({
    name,
    clientGroupID,
    clientID,
    args,
    mutationId,
}: {
    name: string;
    clientGroupID: string;
    clientID: string;
    args: Record<string, unknown>;
    mutationId: number;
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
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    ...args,
                },
            },
        ],
    };
}

async function initList(suffix: string) {
    const { listId, stub } = getListStub(suffix);
    const clientGroupID = `cg_${suffix}`;
    const clientID = `c_${suffix}`;
    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makePush({
            name: 'initList',
            clientGroupID,
            clientID,
            args: { listId, workspaceId: null },
            mutationId: 1,
        }),
    });
    return { listId, stub, clientGroupID, clientID };
}

describe('cascadeArchiveList — shape', () => {
    it('declares the wire name `cascadeArchiveList`', () => {
        expect(cascadeArchiveList.name).toBe('cascadeArchiveList');
    });

    it('gates on SYSTEM_ROLES only', () => {
        // Identity check: a widening or substitution would mean this
        // mutator is reachable from a human session, which the whole
        // "`system` is a real role" design (10a.3) hinges on
        // preventing.
        expect(cascadeArchiveList.requiredRole).toBe(SYSTEM_ROLES);
    });

    it('inverse is null (not user-undoable)', () => {
        const listId = `${IdTypes.list}/${'a'.repeat(ID_LENGTH)}`;
        const cascade_source = makeWorkspaceId('w1');
        expect(
            cascadeArchiveList.inverse({ listId, cascade_source })
        ).toBeNull();
    });

    it('argsSchema accepts a list id', () => {
        const args = {
            listId: `${IdTypes.list}/${'a'.repeat(ID_LENGTH)}`,
            cascade_source: makeWorkspaceId('w1'),
        };
        expect(cascadeArchiveList.argsSchema.safeParse(args).success).toBe(
            true
        );
    });

    it('argsSchema accepts a template id', () => {
        const args = {
            listId: `${IdTypes.template}/${'a'.repeat(ID_LENGTH)}`,
            cascade_source: makeWorkspaceId('w1'),
        };
        expect(cascadeArchiveList.argsSchema.safeParse(args).success).toBe(
            true
        );
    });

    it('argsSchema rejects a workspace id as the target', () => {
        // Workspaces are the trigger of a cascade, not a target;
        // refusing here keeps the type discipline visible.
        const args = {
            listId: makeWorkspaceId('w1'),
            cascade_source: makeWorkspaceId('w2'),
        };
        expect(cascadeArchiveList.argsSchema.safeParse(args).success).toBe(
            false
        );
    });

    it('argsSchema rejects a non-workspace cascade_source', () => {
        const args = {
            listId: `${IdTypes.list}/${'a'.repeat(ID_LENGTH)}`,
            cascade_source: `${IdTypes.list}/${'a'.repeat(ID_LENGTH)}`,
        };
        expect(cascadeArchiveList.argsSchema.safeParse(args).success).toBe(
            false
        );
    });
});

describe('cascadeArchiveList — behavior', () => {
    it('writes time_deleted AND cascade_source on the entity row', async () => {
        const { listId, stub, clientGroupID } = await initList('cas1');
        const cascade_source = makeWorkspaceId('cas1ws');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'system',
            listId,
            pushRequest: makePush({
                name: 'cascadeArchiveList',
                clientGroupID,
                // Synthetic-client shape from ADR 0008: cascade:<ws>:<ts>
                clientID: `cascade:${cascade_source}:${Date.now()}`,
                args: { listId, cascade_source },
                mutationId: 1,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, cascade_source, version
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).not.toBeNull();
        expect(row.cascade_source).toBe(cascade_source);
        expect(row.version).toBe(2);
    });

    it('unarchive after cascade-archive clears cascade_source', async () => {
        // Symmetry: `unarchiveEntity` clears the breadcrumb so a
        // future unrelated cascade sweep can't accidentally pick this
        // row up under an old workspace's id. Important for the
        // restore semantics in 10a.5.
        const { listId, stub, clientGroupID, clientID } = await initList(
            'cas2'
        );
        const cascade_source = makeWorkspaceId('cas2ws');
        const cascadeClientID = `cascade:${cascade_source}:${Date.now()}`;

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'system',
            listId,
            pushRequest: makePush({
                name: 'cascadeArchiveList',
                clientGroupID,
                clientID: cascadeClientID,
                args: { listId, cascade_source },
                mutationId: 1,
            }),
        });

        // Unarchive rides the user's client, mutationId next after
        // init (which used 1 on `clientID`).
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'unarchiveList',
                clientGroupID,
                clientID,
                args: { listId },
                mutationId: 2,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, cascade_source
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).toBeNull();
        expect(row.cascade_source).toBeNull();
    });

    it('refuses a non-system caller (editor) even with valid args', async () => {
        // If this ever passed, the `'system'` role gate would be
        // hollow — any session role could trigger a cascade-archive
        // by sending the wire name + cascade_source. The whole point
        // of SYSTEM_ROLES (10a.3) is that this can't happen.
        const { listId, stub, clientGroupID, clientID } = await initList(
            'cas3'
        );
        const cascade_source = makeWorkspaceId('cas3ws');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'editor',
            listId,
            pushRequest: makePush({
                name: 'cascadeArchiveList',
                clientGroupID,
                clientID,
                args: { listId, cascade_source },
                mutationId: 2,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, cascade_source
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).toBeNull();
        expect(row.cascade_source).toBeNull();
    });

    it('refuses a non-system caller (owner) even with valid args', async () => {
        // Even a workspace owner cannot forge a cascade. The synth-
        // client + system-role path is the only way in.
        const { listId, stub, clientGroupID, clientID } = await initList(
            'cas4'
        );
        const cascade_source = makeWorkspaceId('cas4ws');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                name: 'cascadeArchiveList',
                clientGroupID,
                clientID,
                args: { listId, cascade_source },
                mutationId: 2,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, cascade_source
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).toBeNull();
        expect(row.cascade_source).toBeNull();
    });
});

describe('cascadeArchiveList — projection', () => {
    it('emits cascade_source into the D1 workspace_entities row', async () => {
        // The post-commit `emitEntitySnapshot` reads cascade_source
        // from the DO row and threads it into the snapshot.
        // `EmitEntitySnapshotToCatalog` writes it onto
        // `workspace_entities`, unlocking the
        // `WHERE cascade_source = ?` restore predicate (10a.5).
        const { listId, stub, clientGroupID } = await initList('casp1');
        const cascade_source = makeWorkspaceId('casp1ws');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'system',
            listId,
            pushRequest: makePush({
                name: 'cascadeArchiveList',
                clientGroupID,
                clientID: `cascade:${cascade_source}:${Date.now()}`,
                args: { listId, cascade_source },
                mutationId: 1,
            }),
        });

        // Sanity-check the DO row first — isolates emit-path vs
        // mutator-path failure if this test breaks later.
        const doRow = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT cascade_source FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(doRow.cascade_source).toBe(cascade_source);

        const projected = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(listId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();

        expect(projected).not.toBeNull();
        expect(projected!.cascade_source).toBe(cascade_source);
        expect(projected!.time_deleted).not.toBeNull();
    });
});
