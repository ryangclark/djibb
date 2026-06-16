import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '@djibb/protocol/id';
import * as archiveList from '@djibb/protocol/list/mutators/archiveList';
import * as unarchiveList from '@djibb/protocol/list/mutators/unarchiveList';
import * as renameList from '@djibb/protocol/list/mutators/renameList';

// End-to-end coverage for A.6: archiveList ↔ unarchiveList round-trip,
// inverse-pair declarations, and narrow set-family CAS on renameList.

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

async function init(suffix: string) {
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

describe('unarchiveList end-to-end', () => {
    it('archive then unarchive clears time_deleted on the entity row', async () => {
        const { listId, stub, clientGroupID, clientID } = await init('ul1');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'archiveList',
                clientGroupID,
                clientID,
                args: { listId },
                mutationId: 2,
            }),
        });
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'unarchiveList',
                clientGroupID,
                clientID,
                args: { listId },
                mutationId: 3,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).toBeNull();
        expect(row.version).toBe(3);
    });

    it('archiveList and unarchiveList declare each other as inverses', () => {
        const listId = `${IdTypes.list}/abc-def-ghi-jkl-mno`;
        expect(archiveList.inverse({ listId })).toEqual({
            name: 'unarchiveList',
            args: { listId },
        });
        expect(unarchiveList.inverse({ listId })).toEqual({
            name: 'archiveList',
            args: { listId },
        });
    });
});

describe('renameList narrow CAS (A.6)', () => {
    it('expected mismatch silently no-ops the rename', async () => {
        const { listId, stub, clientGroupID, clientID } = await init('rcas1');

        // Set initial name.
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'renameList',
                clientGroupID,
                clientID,
                args: { listId, name: 'Initial' },
                mutationId: 2,
            }),
        });

        // Try rename with a wrong `expected.name`.
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'renameList',
                clientGroupID,
                clientID,
                args: {
                    listId,
                    name: 'Should-not-land',
                    expected: { name: 'WRONG' },
                },
                mutationId: 3,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT name FROM list_elements WHERE id = ?;`, listId)
                .one()
        );
        expect(row.name).toBe('Initial');
    });

    it('expected match applies the rename', async () => {
        const { listId, stub, clientGroupID, clientID } = await init('rcas2');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'renameList',
                clientGroupID,
                clientID,
                args: { listId, name: 'A' },
                mutationId: 2,
            }),
        });
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'renameList',
                clientGroupID,
                clientID,
                args: {
                    listId,
                    name: 'B',
                    expected: { name: 'A' },
                },
                mutationId: 3,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT name FROM list_elements WHERE id = ?;`, listId)
                .one()
        );
        expect(row.name).toBe('B');
    });

    it('renameList inverse swaps name ↔ expected.name with prior value', () => {
        const listId = `${IdTypes.list}/xyz-aaa-bbb-ccc-ddd`;
        const inv = renameList.inverse(
            { listId, name: 'New' },
            { name: 'Old' }
        );
        expect(inv).toEqual({
            name: 'renameList',
            args: { listId, name: 'Old', expected: { name: 'New' } },
        });
    });

    it('renameList inverse returns null when preState missing', () => {
        const listId = `${IdTypes.list}/xyz-aaa-bbb-ccc-ddd`;
        expect(renameList.inverse({ listId, name: 'New' }, {})).toBeNull();
    });
});
