import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import * as archiveListGroup from '../src/list/mutators/archiveListGroup';
import * as unarchiveListGroup from '../src/list/mutators/unarchiveListGroup';
import * as archiveListGroups from '../src/list/mutators/archiveListGroups';
import * as unarchiveListGroups from '../src/list/mutators/unarchiveListGroups';

// End-to-end coverage for group-level archive/restore (A.5). Symmetric
// to A.4. Cascade-on-archive is not tested here — it's a D.5 question.

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

async function seedGroup(
    stub: DurableObjectStub<DjibbList>,
    { groupId, listId, name }: { groupId: string; listId: string; name: string }
) {
    await runInDurableObject(stub, async (_i, state) => {
        const now = Math.floor(Date.now() / 1000);
        state.storage.sql.exec(
            `INSERT INTO list_elements (
                id, name, description, parent_element_ref,
                child_element_refs, time_created, time_updated,
                type, version
            ) VALUES (?, ?, '', ?, ?, ?, ?, 'group', 1);`,
            groupId,
            name,
            listId,
            JSON.stringify([]),
            now,
            now
        );
    });
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

describe('archiveListGroup / unarchiveListGroup end-to-end', () => {
    it('archive sets time_deleted; unarchive clears it', async () => {
        const { listId, stub } = getListStub('alg1');
        const clientGroupID = 'cg_alg_1';
        const clientID = 'c_alg_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });
        const groupId = newId('group');
        await seedGroup(stub, { groupId, listId, name: 'G' });

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'archiveListGroup',
                clientGroupID,
                clientID,
                args: { id: groupId },
                mutationId: 2,
            }),
        });
        const archived = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted FROM list_elements WHERE id = ?;`,
                    groupId
                )
                .one()
        );
        expect(archived.time_deleted).not.toBeNull();

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'unarchiveListGroup',
                clientGroupID,
                clientID,
                args: { id: groupId },
                mutationId: 3,
            }),
        });
        const restored = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted FROM list_elements WHERE id = ?;`,
                    groupId
                )
                .one()
        );
        expect(restored.time_deleted).toBeNull();
    });

    it('bulk archive/unarchive cycles all listed group ids', async () => {
        const { listId, stub } = getListStub('alg2');
        const clientGroupID = 'cg_alg_2';
        const clientID = 'c_alg_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });
        const a = newId('group');
        const b = newId('group');
        await seedGroup(stub, { groupId: a, listId, name: 'A' });
        await seedGroup(stub, { groupId: b, listId, name: 'B' });

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'archiveListGroups',
                clientGroupID,
                clientID,
                args: { ids: [a, b] },
                mutationId: 2,
            }),
        });
        const both = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted FROM list_elements
                     WHERE id IN (?, ?);`,
                    a,
                    b
                )
                .toArray()
        );
        expect(both[0].time_deleted).not.toBeNull();
        expect(both[1].time_deleted).not.toBeNull();
    });

    it('inverses point pair-wise', () => {
        const idA = newId('group');
        const idB = newId('group');

        expect(archiveListGroup.inverse({ id: idA })).toEqual({
            name: 'unarchiveListGroup',
            args: { id: idA },
        });
        expect(unarchiveListGroup.inverse({ id: idA })).toEqual({
            name: 'archiveListGroup',
            args: { id: idA },
        });
        expect(archiveListGroups.inverse({ ids: [idA, idB] })).toEqual({
            name: 'unarchiveListGroups',
            args: { ids: [idA, idB] },
        });
        expect(unarchiveListGroups.inverse({ ids: [idA, idB] })).toEqual({
            name: 'archiveListGroups',
            args: { ids: [idA, idB] },
        });
    });

    it('rejects archiveListGroup for restricted role', async () => {
        const { listId, stub } = getListStub('alg3');
        const clientGroupID = 'cg_alg_3';
        const clientID = 'c_alg_3';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });
        const groupId = newId('group');
        await seedGroup(stub, { groupId, listId, name: 'G' });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                name: 'archiveListGroup',
                clientGroupID,
                clientID,
                args: { id: groupId },
                mutationId: 2,
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
