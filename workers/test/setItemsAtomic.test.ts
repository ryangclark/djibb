import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1, ReadonlyJSONValue } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { ListItem } from '../src/list';

// End-to-end coverage for `setItemsAtomic` (bulk umbrella, ADR 0005).
// The single-entry CAS path is already covered by setItemFields tests;
// this file focuses on the atomicity guarantee — any one entry's
// mismatch must bail the entire batch.

function getListStub(name: string) {
    const prefixed = `${IdTypes.list}/${name.padEnd(21, 'a').slice(0, 21)}`;
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

function makeItem(listId: string, name: string): ListItem {
    const now = new Date();
    return {
        id: newId('item'),
        name,
        parent_element_ref: listId,
        references_entity_id: null,
        time_created: now,
        time_deleted: null,
        time_updated: now,
        type: 'item',
        value: { target_value: 1, value: 0, unit: 'bool' },
        version: 0,
    };
}

function makeCreateListItemPush({
    clientGroupID,
    clientID,
    item,
    mutationId,
}: {
    clientGroupID: string;
    clientID: string;
    item: ListItem;
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
                name: 'createListItem',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: item.time_created.toISOString(),
                    item: {
                        ...item,
                        time_created: item.time_created.toISOString(),
                        time_deleted: null,
                        time_updated: item.time_updated.toISOString(),
                    },
                },
            },
        ],
    };
}

function makeSetItemsAtomicPush({
    clientGroupID,
    clientID,
    items,
    mutationId,
}: {
    clientGroupID: string;
    clientID: string;
    items: Array<{
        id: string;
        fields: Record<string, unknown>;
        expected?: Record<string, unknown>;
    }>;
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
                name: 'setItemsAtomic',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    items,
                } as ReadonlyJSONValue,
            },
        ],
    };
}

async function setupTwoItems(suffix: string) {
    const { listId, stub } = getListStub(suffix);
    const clientGroupID = `cg_${suffix}`;
    const clientID = `c_${suffix}`;

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
    });

    const a = makeItem(listId, 'A');
    const b = makeItem(listId, 'B');

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeCreateListItemPush({
            clientGroupID,
            clientID,
            item: a,
            mutationId: 2,
        }),
    });
    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeCreateListItemPush({
            clientGroupID,
            clientID,
            item: b,
            mutationId: 3,
        }),
    });

    return { listId, stub, clientGroupID, clientID, a, b };
}

describe('setItemsAtomic end-to-end', () => {
    it('applies all entries when no expected mismatches', async () => {
        const { stub, listId, clientGroupID, clientID, a, b } =
            await setupTwoItems('sia1');

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemsAtomicPush({
                clientGroupID,
                clientID,
                items: [
                    { id: a.id, fields: { name: 'A2' } },
                    { id: b.id, fields: { name: 'B2' } },
                ],
                mutationId: 4,
            }),
        });
        expect(result.error).toBeNull();

        const rows = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT id, name FROM list_elements
                     WHERE id IN (?, ?) ORDER BY name;`,
                    a.id,
                    b.id
                )
                .toArray()
        );
        expect(rows).toEqual([
            { id: a.id, name: 'A2' },
            { id: b.id, name: 'B2' },
        ]);
    });

    it('bails the entire batch when any one expected mismatches', async () => {
        const { stub, listId, clientGroupID, clientID, a, b } =
            await setupTwoItems('sia2');

        // First entry's expected is correct ('A'); second's is wrong.
        // All-or-nothing: neither write should land.
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemsAtomicPush({
                clientGroupID,
                clientID,
                items: [
                    {
                        id: a.id,
                        fields: { name: 'A2' },
                        expected: { name: 'A' },
                    },
                    {
                        id: b.id,
                        fields: { name: 'B2' },
                        expected: { name: 'WRONG' },
                    },
                ],
                mutationId: 4,
            }),
        });

        const rows = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT id, name FROM list_elements
                     WHERE id IN (?, ?) ORDER BY name;`,
                    a.id,
                    b.id
                )
                .toArray()
        );
        expect(rows).toEqual([
            { id: a.id, name: 'A' },
            { id: b.id, name: 'B' },
        ]);
    });

    it('rejects setItemsAtomic for restricted role', async () => {
        const { stub, listId, clientGroupID, clientID, a } =
            await setupTwoItems('sia3');

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeSetItemsAtomicPush({
                clientGroupID,
                clientID,
                items: [{ id: a.id, fields: { name: 'X' } }],
                mutationId: 4,
            }),
        });

        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
