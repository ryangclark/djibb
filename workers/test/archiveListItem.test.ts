import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { ListItem } from '../src/list';
import * as archiveListItem from '../src/list/mutators/archiveListItem';
import * as unarchiveListItem from '../src/list/mutators/unarchiveListItem';
import * as archiveListItems from '../src/list/mutators/archiveListItems';
import * as unarchiveListItems from '../src/list/mutators/unarchiveListItems';

// End-to-end coverage for item-level archive/restore (A.4). Asserts
// the soft-delete writes `time_deleted` on the item row, the unarchive
// clears it, and that the inverse-pair declarations point at each
// other (ADR 0005 §"Archive/restore").

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

function makeArchivePush({
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

describe('archiveListItem / unarchiveListItem end-to-end', () => {
    it('archive sets time_deleted; unarchive clears it', async () => {
        const { listId, stub } = getListStub('ali1');
        const clientGroupID = 'cg_ali_1';
        const clientID = 'c_ali_1';

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

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeArchivePush({
                name: 'archiveListItem',
                clientGroupID,
                clientID,
                args: { id: item.id },
                mutationId: 3,
            }),
        });

        const archived = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one()
        );
        expect(archived.time_deleted).not.toBeNull();
        expect(archived.version).toBe(3);

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeArchivePush({
                name: 'unarchiveListItem',
                clientGroupID,
                clientID,
                args: { id: item.id },
                mutationId: 4,
            }),
        });

        const restored = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one()
        );
        expect(restored.time_deleted).toBeNull();
        expect(restored.version).toBe(4);
    });

    it('bulk archive/unarchive cycles all listed ids', async () => {
        const { listId, stub } = getListStub('ali2');
        const clientGroupID = 'cg_ali_2';
        const clientID = 'c_ali_2';

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

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeArchivePush({
                name: 'archiveListItems',
                clientGroupID,
                clientID,
                args: { ids: [a.id, b.id] },
                mutationId: 4,
            }),
        });

        const both = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT id, time_deleted FROM list_elements
                     WHERE id IN (?, ?) ORDER BY name;`,
                    a.id,
                    b.id
                )
                .toArray()
        );
        expect(both[0].time_deleted).not.toBeNull();
        expect(both[1].time_deleted).not.toBeNull();

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeArchivePush({
                name: 'unarchiveListItems',
                clientGroupID,
                clientID,
                args: { ids: [a.id, b.id] },
                mutationId: 5,
            }),
        });
        const restored = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT id, time_deleted FROM list_elements
                     WHERE id IN (?, ?) ORDER BY name;`,
                    a.id,
                    b.id
                )
                .toArray()
        );
        expect(restored[0].time_deleted).toBeNull();
        expect(restored[1].time_deleted).toBeNull();
    });

    it('inverses point pair-wise', () => {
        const idA = newId('item');
        const idB = newId('item');

        const aInv = archiveListItem.inverse({ id: idA });
        expect(aInv).toEqual({ name: 'unarchiveListItem', args: { id: idA } });

        const uInv = unarchiveListItem.inverse({ id: idA });
        expect(uInv).toEqual({ name: 'archiveListItem', args: { id: idA } });

        const bulkA = archiveListItems.inverse({ ids: [idA, idB] });
        expect(bulkA).toEqual({
            name: 'unarchiveListItems',
            args: { ids: [idA, idB] },
        });

        const bulkU = unarchiveListItems.inverse({ ids: [idA, idB] });
        expect(bulkU).toEqual({
            name: 'archiveListItems',
            args: { ids: [idA, idB] },
        });
    });

    it('rejects archiveListItem for restricted role', async () => {
        const { listId, stub } = getListStub('ali3');
        const clientGroupID = 'cg_ali_3';
        const clientID = 'c_ali_3';

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
            pushRequest: makeArchivePush({
                name: 'archiveListItem',
                clientGroupID,
                clientID,
                args: { id: item.id },
                mutationId: 3,
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
