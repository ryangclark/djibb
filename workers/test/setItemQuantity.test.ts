import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList, asLocalList } from '../src/list/durable_object';
import { IdTypes, newId } from '@djibb/protocol/id';
import type { Quantity } from '@djibb/protocol/list';

// End-to-end integration coverage for the checkbox-toggle path:
//   initList push → seed an item via SQL → setItemQuantity push → pull.
// Uses `runInDurableObject` so we can both call public DO methods
// (handlePush/handlePull) and reach into `state.storage.sql` for
// direct seeding (no `createListItem` server mutator yet).

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

function makeSetItemQuantityPush({
    clientGroupID,
    clientID,
    itemId,
    mutationId,
    quantity,
}: {
    clientGroupID: string;
    clientID: string;
    itemId: string;
    mutationId: number;
    quantity: Quantity;
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
                name: 'setItemQuantity',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    itemId,
                    quantity,
                },
            },
        ],
    };
}

describe('setItemQuantity end-to-end', () => {
    it('updates item value + version, bumps list version, and surfaces in pull', async () => {
        const { listId, stub } = getListStub('toggle1');
        const clientGroupID = 'cg_toggle_1';
        const clientID = 'c_toggle_1';

        // 1. initList push — list row created with version=1 after the
        // push handler bumps via setListVersion.
        const initPushResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });
        expect(initPushResult.error).toBeNull();

        // 2. Seed an item directly (no createListItem server mutator yet).
        const itemId = newId('item');
        const seedQuantity: Quantity = {
            target_value: 1,
            value: 0,
            unit: 'bool',
        };

        await runInDurableObject(stub, async (_instance, state) => {
            state.storage.sql.exec(
                `INSERT INTO list_elements (
                    id, name, parent_element_ref, type, value, version
                ) VALUES (?, ?, ?, ?, ?, ?);`,
                itemId,
                'Test item',
                listId,
                'item',
                JSON.stringify(seedQuantity),
                1
            );
        });

        // 3. Push setItemQuantity. mutation.id must equal current
        // listVersion + 1 = 2 (per `_handlePush` semantics).
        const newQuantity: Quantity = {
            target_value: 1,
            value: 1, // checkbox checked
            unit: 'bool',
        };

        const setPushResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemQuantityPush({
                clientGroupID,
                clientID,
                itemId,
                mutationId: 2,
                quantity: newQuantity,
            }),
        });
        expect(setPushResult.error).toBeNull();

        // 4. Verify directly: item row got new value + version=2; list
        // row got version=2.
        const { itemValueJson, itemVersion, listVersion } =
            await runInDurableObject(stub, async (_instance, state) => {
                const itemRow = state.storage.sql
                    .exec(
                        `SELECT value, version FROM list_elements WHERE id = ?;`,
                        itemId
                    )
                    .one();
                const listRow = state.storage.sql
                    .exec(
                        `SELECT version FROM list_elements WHERE type = 'list' LIMIT 1;`
                    )
                    .one();
                return {
                    itemValueJson: itemRow.value as string,
                    itemVersion: itemRow.version as number,
                    listVersion: listRow.version as number,
                };
            });

        expect(itemVersion).toBe(2);
        expect(listVersion).toBe(2);
        expect(JSON.parse(itemValueJson)).toEqual(newQuantity);

        // 4b. Mutation log: envelope fields landed in their dedicated
        // columns (not stuffed into the `args` JSON). `timestamp_client`
        // is unix-seconds; `args` carries body fields only — no
        // `accountId` / `timestamp_client` re-stuffing.
        const mutationRows = await runInDurableObject(
            stub,
            async (_instance, state) => {
                const cursor = state.storage.sql.exec(
                    `SELECT id, name, account_id, timestamp_client, args, status
                     FROM mutations
                     WHERE name = 'setItemQuantity';`
                );
                return cursor.toArray();
            }
        );
        expect(mutationRows).toHaveLength(1);
        const mutationRow = mutationRows[0]!;
        expect(mutationRow.status).toBe('succeeded');
        expect(mutationRow.account_id).toBeNull();
        expect(typeof mutationRow.timestamp_client).toBe('number');
        expect(mutationRow.timestamp_client).toBeGreaterThan(0);
        const persistedArgs = JSON.parse(mutationRow.args as string);
        expect(persistedArgs).toEqual({ itemId, quantity: newQuantity });
        expect(persistedArgs).not.toHaveProperty('accountId');
        expect(persistedArgs).not.toHaveProperty('timestamp_client');

        // 5. Pull from v=1; the item row (version=2) should land
        // in the patch.
        const pullResult = await asLocalList(stub).handlePull({
            authorizedRole: 'ownerless',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: { v: 1, r: 'ownerless' },
                schemaVersion: '1',
            },
        });
        expect(pullResult.error).toBeNull();
        const pullData = pullResult.data!;
        expect(pullData.cookie).toMatchObject({ v: 2 });

        const itemPatch = pullData.patch.find(
            entry => entry.op === 'put' && entry.key === itemId
        );
        expect(itemPatch).toBeDefined();
        expect(itemPatch?.op).toBe('put');
        if (itemPatch?.op === 'put') {
            expect(itemPatch.value).toMatchObject({
                id: itemId,
                type: 'item',
                version: 2,
                value: newQuantity,
            });
        }
    });

    it('rejects setItemQuantity for restricted role', async () => {
        const { listId, stub } = getListStub('toggle2');
        const clientGroupID = 'cg_toggle_2';
        const clientID = 'c_toggle_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });

        const itemId = newId('item');
        await runInDurableObject(stub, async (_instance, state) => {
            state.storage.sql.exec(
                `INSERT INTO list_elements (
                    id, name, parent_element_ref, type, value, version
                ) VALUES (?, ?, ?, ?, ?, ?);`,
                itemId,
                'Restricted item',
                listId,
                'item',
                JSON.stringify({ target_value: 1, value: 0, unit: 'bool' }),
                1
            );
        });

        // The push handler wraps everything in tryCatch — UnauthorizedError
        // bubbles up via the Result.error channel.
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeSetItemQuantityPush({
                clientGroupID,
                clientID,
                itemId,
                mutationId: 2,
                quantity: { target_value: 1, value: 1, unit: 'bool' },
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
