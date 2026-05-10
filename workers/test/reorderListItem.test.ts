import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { ListItem } from '../src/list';
import * as reorderListItem from '../src/list/mutators/reorderListItem';

// End-to-end coverage for reorderListItem (A.7). Move + CAS-stale +
// inverse declaration. Group reorder is symmetric; one item-side
// suite proves the helper.

function getListStub(name: string) {
    const prefixed = `${IdTypes.list}/${name.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
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

async function setupThree(suffix: string) {
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
    const a = makeItem(listId, 'A');
    const b = makeItem(listId, 'B');
    const c = makeItem(listId, 'C');
    let nextId = 2;
    for (const item of [a, b, c]) {
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: {
                profileID: 'p_test',
                clientGroupID,
                pushVersion: 1,
                schemaVersion: '1',
                mutations: [
                    {
                        clientID,
                        id: nextId++,
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
            },
        });
    }
    return { listId, stub, clientGroupID, clientID, a, b, c, nextId };
}

async function readChildRefs(stub: DurableObjectStub<DjibbList>, listId: string) {
    const row = await runInDurableObject(stub, async (_i, state) =>
        state.storage.sql
            .exec(
                `SELECT child_element_refs FROM list_elements WHERE id = ?;`,
                listId
            )
            .one()
    );
    return JSON.parse(row.child_element_refs as string) as string[];
}

describe('reorderListItem end-to-end', () => {
    it('moves the item to the requested index', async () => {
        const { listId, stub, clientGroupID, clientID, a, b, c, nextId } =
            await setupThree('rl1');

        // Initial order: [A, B, C]. Move A → index 2 → [B, C, A].
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'reorderListItem',
                clientGroupID,
                clientID,
                args: { id: a.id, toIndex: 2 },
                mutationId: nextId,
            }),
        });
        const refs = await readChildRefs(stub, listId);
        expect(refs).toEqual([b.id, c.id, a.id]);
    });

    it('CAS-stale (expected.fromIndex mismatch) silently no-ops', async () => {
        const { listId, stub, clientGroupID, clientID, a, b, c, nextId } =
            await setupThree('rl2');

        // A is at index 0; pretend we expect it at 5 → no-op.
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'reorderListItem',
                clientGroupID,
                clientID,
                args: {
                    id: a.id,
                    toIndex: 2,
                    expected: { fromIndex: 5 },
                },
                mutationId: nextId,
            }),
        });
        const refs = await readChildRefs(stub, listId);
        expect(refs).toEqual([a.id, b.id, c.id]);
    });

    it('inverse swaps toIndex with the captured fromIndex and CAS-guards', () => {
        const id = newId('item');
        const inv = reorderListItem.inverse(
            { id, toIndex: 4 },
            { fromIndex: 1 }
        );
        expect(inv).toEqual({
            name: 'reorderListItem',
            args: {
                id,
                toIndex: 1,
                expected: { fromIndex: 4 },
            },
        });
    });

    it('inverse returns null when preState is missing', () => {
        const id = newId('item');
        expect(
            reorderListItem.inverse({ id, toIndex: 2 }, {})
        ).toBeNull();
    });

    it('rejects reorderListItem for restricted role', async () => {
        const { listId, stub, clientGroupID, clientID, a, nextId } =
            await setupThree('rl3');

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                name: 'reorderListItem',
                clientGroupID,
                clientID,
                args: { id: a.id, toIndex: 2 },
                mutationId: nextId,
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
