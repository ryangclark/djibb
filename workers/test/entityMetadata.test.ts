import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1, ReadonlyJSONObject } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '../src/id';
import type { AuthorizationRules } from '../src/auth/rules';

// Coverage for the entity-metadata mutator triplet:
//   archiveList, setDescription, setListAuthRules.
// The fuller `renameList.test.ts` file is the canonical template for
// metadata mutator end-to-end testing; this file focuses on what's
// distinctive about each of the three (soft-delete + del-on-pull,
// description round-trip, OWNER_ROLES gating).

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

function makeMetadataPush<TBody extends ReadonlyJSONObject>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
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
                    ...body,
                },
            },
        ],
    };
}

describe('archiveList end-to-end', () => {
    it('soft-deletes the entity row and pull emits a `del` op', async () => {
        const { listId, stub } = getListStub('archive1');
        const clientGroupID = 'cg_archive_1';
        const clientID = 'c_archive_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const archiveResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'archiveList',
                mutationId: 2,
                body: { listId },
            }),
        });
        expect(archiveResult.error).toBeNull();

        // The DO row carries a non-null time_deleted; version bumped.
        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT time_deleted, version
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.time_deleted).not.toBeNull();
        expect(row.version).toBe(2);

        // A pull from v=1 ("I have version 1") sees the archived row's
        // bumped version and emits a `del` op so the client drops the
        // entity from its store.
        const pullResult = await (stub as unknown as DjibbList).handlePull({
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
        const delPatch = pullResult.data!.patch.find(
            entry => entry.op === 'del' && entry.key === listId
        );
        expect(delPatch).toBeDefined();
        expect(delPatch?.op).toBe('del');
    });
});

describe('setDescription end-to-end', () => {
    it('writes the description to the entity row and surfaces in pull', async () => {
        const { listId, stub } = getListStub('desc1');
        const clientGroupID = 'cg_desc_1';
        const clientID = 'c_desc_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const description = 'Camping packlist for Moab — keep it light.';
        const setResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'setDescription',
                mutationId: 2,
                body: { listId, description },
            }),
        });
        expect(setResult.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT description, version FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.description).toBe(description);
        expect(row.version).toBe(2);

        // Pull from scratch — the entity row's `description` round-trips
        // through the patch.
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
        if (listPatch?.op === 'put') {
            expect(listPatch.value).toMatchObject({
                id: listId,
                description,
                version: 2,
            });
        }
    });

    it('clears the description when passed an empty string', async () => {
        const { listId, stub } = getListStub('desc2');
        const clientGroupID = 'cg_desc_2';
        const clientID = 'c_desc_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        // Set, then clear.
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'setDescription',
                mutationId: 2,
                body: { listId, description: 'temporary' },
            }),
        });
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'setDescription',
                mutationId: 3,
                body: { listId, description: '' },
            }),
        });

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT description, version FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.description).toBe('');
        expect(row.version).toBe(3);
    });
});

describe('setListAuthRules end-to-end', () => {
    const newRules: AuthorizationRules = {
        authorized_accounts: { 'a/abc': { role: 'owner' } },
        default_role: 'restricted',
        set_by: 'user',
    };

    it('replaces the entity authorization_rules whole', async () => {
        const { listId, stub } = getListStub('auth1');
        const clientGroupID = 'cg_auth_1';
        const clientID = 'c_auth_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const result = await stub.handlePush({
            authorizedAccounts: [],
            // OWNER_ROLES includes 'owner' — required for this mutator.
            authorizedRole: 'owner',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'setListAuthRules',
                mutationId: 2,
                body: { listId, authorization_rules: newRules },
            }),
        });
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT authorization_rules, version
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(JSON.parse(row.authorization_rules as string)).toEqual(newRules);
        expect(row.version).toBe(2);
    });

    it('rejects setListAuthRules for editor role (OWNER_ROLES only)', async () => {
        const { listId, stub } = getListStub('auth2');
        const clientGroupID = 'cg_auth_2';
        const clientID = 'c_auth_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        // editor is in EDIT_ROLES but NOT in OWNER_ROLES — dispatch
        // should return unauthorized, which the DO surfaces as an
        // UnauthorizedError on the Result.error channel.
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'editor',
            listId,
            pushRequest: makeMetadataPush({
                clientGroupID,
                clientID,
                name: 'setListAuthRules',
                mutationId: 2,
                body: { listId, authorization_rules: newRules },
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
