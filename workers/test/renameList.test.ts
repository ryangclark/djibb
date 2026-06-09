import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '../src/id';

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

function makeRenameListPush({
    clientGroupID,
    clientID,
    listId,
    mutationId,
    name,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    mutationId: number;
    name: string;
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
                name: 'renameList',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    listId,
                    name,
                    timestamp_client: new Date().toISOString(),
                },
            },
        ],
    };
}

describe('renameList end-to-end', () => {
    it('updates name and bumps version on the entity row', async () => {
        const { listId, stub } = getListStub('rename1');
        const clientGroupID = 'cg_rename_1';
        const clientID = 'c_rename_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeRenameListPush({
                clientGroupID,
                clientID,
                listId,
                mutationId: 2,
                name: 'My Renamed List',
            }),
        });
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, version FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.name).toBe('My Renamed List');
        expect(row.version).toBe(2);

        const pullResult = await (stub as unknown as DjibbList).handlePull({
            authorizedRole: 'ownerless',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(pullResult.error).toBeNull();
        const listPatch = pullResult.data!.patch.find(
            entry => entry.op === 'put' && entry.key === listId
        );
        expect(listPatch).toBeDefined();
        if (listPatch?.op === 'put') {
            expect(listPatch.value).toMatchObject({
                id: listId,
                name: 'My Renamed List',
                type: 'list',
                version: 2,
            });
        }
    });

    it('rejects renameList for restricted role', async () => {
        const { listId, stub } = getListStub('rename2');
        const clientGroupID = 'cg_rename_2';
        const clientID = 'c_rename_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeRenameListPush({
                clientGroupID,
                clientID,
                listId,
                mutationId: 2,
                name: 'Forbidden',
            }),
        });

        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
