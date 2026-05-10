import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { ListItem, Quantity } from '../src/list';

// End-to-end coverage for `setItemFields` (umbrella set-family
// mutator from ADR 0005). Mirrors the createListItem / setItemQuantity
// test style: init → create → setFields → assert SQL + pull patch.

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

function makeItem(
    listId: string,
    name: string,
    overrides: Partial<ListItem> = {}
): ListItem {
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
        ...overrides,
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

function makeSetItemFieldsPush({
    clientGroupID,
    clientID,
    id,
    fields,
    expected,
    mutationId,
}: {
    clientGroupID: string;
    clientID: string;
    id: string;
    fields: Record<string, unknown>;
    expected?: Record<string, unknown>;
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
                name: 'setItemFields',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    id,
                    fields,
                    ...(expected ? { expected } : {}),
                },
            },
        ],
    };
}

describe('setItemFields end-to-end', () => {
    it('writes only the listed fields and bumps version', async () => {
        const { listId, stub } = getListStub('sif1');
        const clientGroupID = 'cg_sif_1';
        const clientID = 'c_sif_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'Original');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        const refTarget = newId('template');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemFieldsPush({
                clientGroupID,
                clientID,
                id: item.id,
                fields: {
                    name: 'Renamed',
                    references_entity_id: refTarget,
                },
                mutationId: 3,
            }),
        });
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, references_entity_id, parent_element_ref,
                            value, version
                     FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one()
        );
        expect(row.name).toBe('Renamed');
        expect(row.references_entity_id).toBe(refTarget);
        // Untouched fields stay put.
        expect(row.parent_element_ref).toBe(listId);
        expect(JSON.parse(row.value as string)).toEqual(item.value);
        // version bumps once for create, once for setFields.
        expect(row.version).toBe(3);
    });

    it('writes a Quantity (JSON-encoded value column)', async () => {
        const { listId, stub } = getListStub('sif2');
        const clientGroupID = 'cg_sif_2';
        const clientID = 'c_sif_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'Q');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        const newQty: Quantity = { target_value: 5, value: 3, unit: 'count' };
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemFieldsPush({
                clientGroupID,
                clientID,
                id: item.id,
                fields: { value: newQty },
                mutationId: 3,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT value FROM list_elements WHERE id = ?;`, item.id)
                .one()
        );
        expect(JSON.parse(row.value as string)).toEqual(newQty);
    });

    it('CAS no-ops the entire mutation when expected mismatches', async () => {
        const { listId, stub } = getListStub('sif3');
        const clientGroupID = 'cg_sif_3';
        const clientID = 'c_sif_3';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'Original');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        // expected.name doesn't match — entire mutation should no-op.
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemFieldsPush({
                clientGroupID,
                clientID,
                id: item.id,
                fields: { name: 'Should-not-land', references_entity_id: 'x' },
                expected: { name: 'WRONG' },
                mutationId: 3,
            }),
        });
        // CAS-stale is silently dropped today (B.1 wires the outcome
        // channel); push reports no envelope-level error.
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, references_entity_id, version
                     FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one()
        );
        // name stays 'Original'; references_entity_id wasn't written
        // (all-or-nothing).
        expect(row.name).toBe('Original');
        expect(row.references_entity_id).toBeNull();
    });

    it('CAS applies when expected matches', async () => {
        const { listId, stub } = getListStub('sif4');
        const clientGroupID = 'cg_sif_4';
        const clientID = 'c_sif_4';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'Original');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemFieldsPush({
                clientGroupID,
                clientID,
                id: item.id,
                fields: { name: 'Replaced' },
                expected: { name: 'Original' },
                mutationId: 3,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT name FROM list_elements WHERE id = ?;`, item.id)
                .one()
        );
        expect(row.name).toBe('Replaced');
    });

    it('rejects setItemFields for restricted role', async () => {
        const { listId, stub } = getListStub('sif5');
        const clientGroupID = 'cg_sif_5';
        const clientID = 'c_sif_5';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'Item');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeSetItemFieldsPush({
                clientGroupID,
                clientID,
                id: item.id,
                fields: { name: 'Forbidden' },
                mutationId: 3,
            }),
        });

        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
