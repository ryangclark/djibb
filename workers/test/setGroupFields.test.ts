import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';

// End-to-end coverage for `setGroupFields` (umbrella set-family,
// ADR 0005). No `createListGroup` mutator exists yet (D.4); groups
// are seeded via direct sql exec inside the DO.

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
    {
        groupId,
        listId,
        name,
        description,
    }: {
        groupId: string;
        listId: string;
        name: string;
        description?: string;
    }
) {
    await runInDurableObject(stub, async (_i, state) => {
        const now = Math.floor(Date.now() / 1000);
        state.storage.sql.exec(
            `INSERT INTO list_elements (
                id, name, description, parent_element_ref,
                child_element_refs, time_created, time_updated,
                type, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'group', 1);`,
            groupId,
            name,
            description ?? '',
            listId,
            JSON.stringify([]),
            now,
            now
        );
    });
}

function makeSetGroupFieldsPush({
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
                name: 'setGroupFields',
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

describe('setGroupFields end-to-end', () => {
    it('writes only the listed fields and bumps version', async () => {
        const { listId, stub } = getListStub('sgf1');
        const clientGroupID = 'cg_sgf_1';
        const clientID = 'c_sgf_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const groupId = newId('group');
        await seedGroup(stub, {
            groupId,
            listId,
            name: 'Original',
            description: 'desc',
        });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetGroupFieldsPush({
                clientGroupID,
                clientID,
                id: groupId,
                fields: { name: 'Renamed' },
                mutationId: 2,
            }),
        });
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, description, parent_element_ref, version
                     FROM list_elements WHERE id = ?;`,
                    groupId
                )
                .one()
        );
        expect(row.name).toBe('Renamed');
        // Untouched fields stay put.
        expect(row.description).toBe('desc');
        expect(row.parent_element_ref).toBe(listId);
        expect(row.version).toBe(2);
    });

    it('CAS no-ops the entire mutation when expected mismatches', async () => {
        const { listId, stub } = getListStub('sgf2');
        const clientGroupID = 'cg_sgf_2';
        const clientID = 'c_sgf_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const groupId = newId('group');
        await seedGroup(stub, { groupId, listId, name: 'Original' });

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetGroupFieldsPush({
                clientGroupID,
                clientID,
                id: groupId,
                fields: { name: 'Should-not-land', description: 'either' },
                expected: { name: 'WRONG' },
                mutationId: 2,
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, description FROM list_elements WHERE id = ?;`,
                    groupId
                )
                .one()
        );
        expect(row.name).toBe('Original');
        // All-or-nothing: description didn't move either.
        expect(row.description).toBe('');
    });

    it('rejects setGroupFields for restricted role', async () => {
        const { listId, stub } = getListStub('sgf3');
        const clientGroupID = 'cg_sgf_3';
        const clientID = 'c_sgf_3';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const groupId = newId('group');
        await seedGroup(stub, { groupId, listId, name: 'Group' });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeSetGroupFieldsPush({
                clientGroupID,
                clientID,
                id: groupId,
                fields: { name: 'Forbidden' },
                mutationId: 2,
            }),
        });

        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
