import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { garbageCollectReplicacheClients } from '../src/list/sql';
import { IdTypes } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

/**
 * Replicache client-table GC (GH #35).
 *
 * `handlePush` persists a `replicache_clients` + `replicache_client_groups`
 * row-pair per client into the entity DO's SQLite. On a public write
 * surface (`djibb contribute` against a `submitter` list) every
 * contribution mints a fresh one-shot client, so the tables grow without
 * bound. `garbageCollectReplicacheClients` reclaims them by *version lag*
 * (a one-shot writer's `last_modified_version` freezes and falls behind
 * the list), and `handleReconcile` runs it on the daily alarm.
 *
 * Two layers here: the pure SQL helper (exact reap/keep semantics against
 * a real DO's SQLite) and the reconcile integration (the alarm actually
 * calls it).
 */

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makeInitListPush(listId: string): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID: 'cg_gc_init',
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: 'c_gc_init',
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

/** Initialize a DO's schema + entity row by pushing an `initList`. */
async function initDo(suffix: string) {
    const { listId, stub } = getListStub(suffix);
    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush(listId),
    });
    // The init push persists its own `cg_gc_init`/`c_gc_init` row-pair.
    // Clear the client tables so each test controls the exact population
    // (the entity row + schema stay intact).
    await runInDurableObject(stub, (_i, state) => {
        state.storage.sql.exec(`DELETE FROM replicache_clients;`);
        state.storage.sql.exec(`DELETE FROM replicache_client_groups;`);
    });
    return { listId, stub };
}

/** Insert a client-group + client row-pair directly into the DO SQLite. */
async function seedClient(
    stub: DurableObjectStub<DjibbList>,
    groupId: string,
    clientId: string,
    lastModifiedVersion: number,
) {
    await runInDurableObject(stub, (_i, state) => {
        state.storage.sql.exec(
            `INSERT OR IGNORE INTO replicache_client_groups (id, account_id)
             VALUES (?, NULL);`,
            groupId,
        );
        state.storage.sql.exec(
            `INSERT INTO replicache_clients
                (id, client_group_id, last_modified_version, last_mutation_id)
             VALUES (?, ?, ?, 1);`,
            clientId,
            groupId,
            lastModifiedVersion,
        );
    });
}

async function clientIds(stub: DurableObjectStub<DjibbList>): Promise<string[]> {
    return runInDurableObject(stub, (_i, state) => {
        const out: string[] = [];
        for (const row of state.storage.sql.exec(
            `SELECT id FROM replicache_clients ORDER BY id;`,
        )) {
            out.push(row['id'] as string);
        }
        return out;
    });
}

async function groupIds(stub: DurableObjectStub<DjibbList>): Promise<string[]> {
    return runInDurableObject(stub, (_i, state) => {
        const out: string[] = [];
        for (const row of state.storage.sql.exec(
            `SELECT id FROM replicache_client_groups ORDER BY id;`,
        )) {
            out.push(row['id'] as string);
        }
        return out;
    });
}

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

describe('garbageCollectReplicacheClients (version-lag reap)', () => {
    it('reaps clients past the lag cutoff, keeps recent ones', async () => {
        const { stub } = await initDo('gc-reap-1');
        // Current version 5000, lag 1000 → cutoff 4000.
        await seedClient(stub, 'cg_stale', 'c_stale', 100); // < 4000 → reap
        await seedClient(stub, 'cg_edge_out', 'c_edge_out', 3999); // < 4000 → reap
        await seedClient(stub, 'cg_edge_in', 'c_edge_in', 4000); // == 4000 → keep
        await seedClient(stub, 'cg_recent', 'c_recent', 4999); // > 4000 → keep

        const res = await runInDurableObject(stub, (_i, state) =>
            garbageCollectReplicacheClients(state.storage.sql, 5000, 1000),
        );

        expect(res.clientsDeleted).toBe(2);
        expect(await clientIds(stub)).toEqual(['c_edge_in', 'c_recent']);
    });

    it('reaps the client group only once its last client is gone', async () => {
        const { stub } = await initDo('gc-group-1');
        // A group with a stale and a live client survives (still has a
        // member); a group with only stale clients is reaped.
        await seedClient(stub, 'cg_mixed', 'c_mixed_stale', 100);
        await seedClient(stub, 'cg_mixed', 'c_mixed_live', 4999);
        await seedClient(stub, 'cg_dead', 'c_dead_a', 100);
        await seedClient(stub, 'cg_dead', 'c_dead_b', 200);

        const res = await runInDurableObject(stub, (_i, state) =>
            garbageCollectReplicacheClients(state.storage.sql, 5000, 1000),
        );

        // Only cg_dead is emptied and reaped; cg_mixed keeps its live
        // member so the group survives.
        expect(res.clientGroupsDeleted).toBe(1);
        const groups = await groupIds(stub);
        expect(groups).toContain('cg_mixed');
        expect(groups).not.toContain('cg_dead');
    });

    it('never reaps reserved single-writer identities however far behind', async () => {
        const { stub } = await initDo('gc-reserved-1');
        await seedClient(stub, 'cg_cascade:ws_1', 'c_cascade', 1);
        await seedClient(stub, 'cg_signup_acct_1', 'c_signup', 1);
        await seedClient(stub, 'cg_cli:op_1', 'c_cli', 1);

        const res = await runInDurableObject(stub, (_i, state) =>
            garbageCollectReplicacheClients(state.storage.sql, 999999, 1000),
        );

        expect(res.clientsDeleted).toBe(0);
        const clients = await clientIds(stub);
        expect(clients).toEqual(
            expect.arrayContaining(['c_cascade', 'c_cli', 'c_signup']),
        );
        const groups = await groupIds(stub);
        expect(groups).toEqual(
            expect.arrayContaining([
                'cg_cascade:ws_1',
                'cg_cli:op_1',
                'cg_signup_acct_1',
            ]),
        );
    });

    it('reaps ids that match the reserved prefix only via LIKE wildcards', async () => {
        const { stub } = await initDo('gc-wildcard-1');
        // `cgAsignupB` matches the *unescaped* pattern `cg_signup_%` (the
        // `_`s are single-char wildcards) but is NOT the literal
        // `cg_signup_` prefix, so it must still be reaped (GH #35 review).
        await seedClient(stub, 'cgAsignupB', 'c_wildcard', 1);

        const res = await runInDurableObject(stub, (_i, state) =>
            garbageCollectReplicacheClients(state.storage.sql, 5000, 1000),
        );

        expect(res.clientsDeleted).toBe(1);
        expect(await clientIds(stub)).not.toContain('c_wildcard');
    });

    it('no-ops when the cutoff is non-positive (e.g. a list younger than the lag)', async () => {
        const { stub } = await initDo('gc-noop-1');
        await seedClient(stub, 'cg_anything', 'c_anything', 0);

        // currentVersion 500 <= maxLag 1000 → cutoff -500 → skip writes.
        const res = await runInDurableObject(stub, (_i, state) =>
            garbageCollectReplicacheClients(state.storage.sql, 500, 1000),
        );

        expect(res).toEqual({ clientsDeleted: 0, clientGroupsDeleted: 0 });
        expect(await clientIds(stub)).toContain('c_anything');
    });
});

describe('handleReconcile runs the client GC (GH #35)', () => {
    const ORIGINAL_LAG = DjibbList.REPLICACHE_CLIENT_GC_MAX_VERSION_LAG;
    afterEach(() => {
        DjibbList.REPLICACHE_CLIENT_GC_MAX_VERSION_LAG = ORIGINAL_LAG;
    });

    it('reaps a stale client on the reconcile tick, keeps a recent one', async () => {
        const { stub } = await initDo('gc-reconcile-1');

        // Drive the list version up so real lag exists, then seed a stale
        // + a recent client relative to it.
        await runInDurableObject(stub, (_i, state) => {
            state.storage.sql.exec(
                `UPDATE list_elements SET version = 100
                 WHERE type IN ('list','template');`,
            );
        });
        DjibbList.REPLICACHE_CLIENT_GC_MAX_VERSION_LAG = 10; // cutoff 90
        await seedClient(stub, 'cg_recon_stale', 'c_recon_stale', 5);
        await seedClient(stub, 'cg_recon_recent', 'c_recon_recent', 95);
        await seedClient(stub, 'cg_cascade:ws_x', 'c_recon_cascade', 1);

        await runInDurableObject(stub, (i) => i.handleReconcile());

        const clients = await clientIds(stub);
        expect(clients).not.toContain('c_recon_stale');
        expect(clients).toContain('c_recon_recent');
        expect(clients).toContain('c_recon_cascade'); // reserved
    });
});
