// ADR 0021 §Decision 1 / issue #13 — read view-floor tests.
//
// The companion to `pullFilter.test.ts`. Where that file gates a
// per-role *keyspace* (`pending_invites/*`), this file gates *content*
// itself (`l/`, `i/`, `g/` keys) behind the read floor in
// `_handlePull`. A regression here is a confidentiality leak: a
// `restricted`/`submitter` caller seeing entity content the floor is
// meant to deny.
//
// Covers the issue #13 test checklist:
//   1. below-floor (restricted / submitter) pull contains NO content
//      keys and is empty-not-403 (succeeds, cookie advances)
//   2. ownerless IS above the floor — anonymous Blanks (the Contributed
//      Lists) stay publicly readable
//   3. demotion (was-viewer, now-restricted) emits `op:'del'` for the
//      content the client could previously see (reads become revocable)
//   4. promotion (was-restricted, now-viewer) emits content as fresh
//      `put` ops (full-sync, not a missed diff)
//
// For broader testing conventions see `docs/testing.md`.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { PushRequestV1 } from 'replicache';

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

function makeCreateItemPush({
    clientGroupID,
    clientID,
    listId,
    itemId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    itemId: string;
}): PushRequestV1 {
    const now = new Date().toISOString();
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: 2,
                name: 'createListItem',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: now,
                    item: {
                        id: itemId,
                        name: 'a secret item',
                        parent_element_ref: listId,
                        references_entity_id: null,
                        type: 'item',
                        value: { target_value: 1, value: 0, unit: 'bool' },
                        version: 0,
                        time_created: now,
                        time_updated: now,
                        time_deleted: null,
                    },
                },
            },
        ],
    };
}

/**
 * Seed an entity (initList) with one content item (createListItem),
 * returning the ids plus a Replicache client group. Both content keys
 * (`listId` entity row and `itemId`) become the subject of the
 * view-floor assertions below.
 */
async function seedListWithItem(suffix: string) {
    const { listId, stub } = getListStub(suffix);
    const clientGroupID = `cg_${suffix}`;
    const clientID = `c_${suffix}`;
    const itemId = newId('item');

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
    });
    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'owner',
        listId,
        pushRequest: makeCreateItemPush({
            clientGroupID,
            clientID,
            listId,
            itemId,
        }),
    });

    return { listId, itemId, stub, clientGroupID, clientID };
}

function freshPull(clientGroupID: string) {
    return {
        pullVersion: 1 as const,
        profileID: 'p_test',
        clientGroupID,
        cookie: null,
        schemaVersion: '1',
    };
}

function hasContentKey(
    patch: readonly unknown[],
    key: string,
    op?: 'put' | 'del'
): boolean {
    return patch.some(entry => {
        const e = entry as { op: string; key?: string };
        if (op && e.op !== op) return false;
        return e.key === key;
    });
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('view floor — below-floor roles see no content', () => {
    for (const role of ['restricted', 'submitter'] as const) {
        it(`${role} pull contains NO content keys and is empty-not-403`, async () => {
            const { listId, itemId, stub, clientGroupID } =
                await seedListWithItem(`vf_${role}`);

            const result = await asLocalList(stub).handlePull({
                authorizedRole: role,
                listId,
                pullRequest: freshPull(clientGroupID),
            });

            // Empty-not-403: the pull SUCCEEDS (no error) — a 403 would
            // make Replicache retry-storm.
            expect(result.error).toBeNull();

            // The load-bearing assertion: no content keys whatsoever.
            expect(hasContentKey(result.data!.patch, listId)).toBe(false);
            expect(hasContentKey(result.data!.patch, itemId)).toBe(false);

            // The cookie still advances (carries the current role), so
            // the client converges instead of looping on v0.
            expect(result.data!.cookie).toMatchObject({ r: role });
        });
    }
});

describe('view floor — at/above-floor roles see content', () => {
    for (const role of ['ownerless', 'viewer'] as const) {
        it(`${role} pull DOES contain content keys as put ops`, async () => {
            const { listId, itemId, stub, clientGroupID } =
                await seedListWithItem(`vf_${role}`);

            const result = await asLocalList(stub).handlePull({
                authorizedRole: role,
                listId,
                pullRequest: freshPull(clientGroupID),
            });
            expect(result.error).toBeNull();

            // ownerless is the role anonymous Blanks resolve to — the
            // Contributed Lists MUST stay readable. viewer is the
            // canonical reader.
            expect(hasContentKey(result.data!.patch, listId, 'put')).toBe(true);
            expect(hasContentKey(result.data!.patch, itemId, 'put')).toBe(true);
        });
    }
});

describe('view floor — reads are revocable (role transitions)', () => {
    it('demotion: was-viewer now-restricted pull emits del for content', async () => {
        const { listId, itemId, stub, clientGroupID } =
            await seedListWithItem('vf_demote');

        // Learn the entity version the client would have cached as viewer.
        const asViewer = await asLocalList(stub).handlePull({
            authorizedRole: 'viewer',
            listId,
            pullRequest: freshPull(clientGroupID),
        });
        const v = (asViewer.data!.cookie as unknown as { v: number }).v;

        // Same client, now demoted to restricted, presenting its prior
        // viewer cookie. It must lose the content it cached.
        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'restricted',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: { v, r: 'viewer' },
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        // del for every content key it could previously see…
        expect(hasContentKey(result.data!.patch, listId, 'del')).toBe(true);
        expect(hasContentKey(result.data!.patch, itemId, 'del')).toBe(true);
        // …and NOT re-delivered as puts.
        expect(hasContentKey(result.data!.patch, listId, 'put')).toBe(false);
        expect(hasContentKey(result.data!.patch, itemId, 'put')).toBe(false);
    });

    it('promotion: was-restricted now-viewer pull full-syncs content as puts', async () => {
        const { listId, itemId, stub, clientGroupID } =
            await seedListWithItem('vf_promote');

        const v = await (async () => {
            const r = await asLocalList(stub).handlePull({
                authorizedRole: 'owner',
                listId,
                pullRequest: freshPull(clientGroupID),
            });
            return (r.data!.cookie as unknown as { v: number }).v;
        })();

        // Client was below the floor (saw nothing) and is now a viewer,
        // presenting a non-zero version. A plain diff since `v` would
        // miss the already-existing rows — promotion must full-sync.
        const result = await asLocalList(stub).handlePull({
            authorizedRole: 'viewer',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: { v, r: 'restricted' },
                schemaVersion: '1',
            },
        });
        expect(result.error).toBeNull();

        expect(hasContentKey(result.data!.patch, listId, 'put')).toBe(true);
        expect(hasContentKey(result.data!.patch, itemId, 'put')).toBe(true);
    });
});
