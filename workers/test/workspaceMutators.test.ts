// ADR 0011 §Step 5: tests for `createWorkspace`, `renameWorkspace`,
// `setWorkspaceImage`. Pattern mirrors transferOwnership.test.ts —
// DjibbList.handlePush round-trips assert end-state on the DO's
// `list_elements` row.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { AuthorizationRules } from '../src/auth/rules';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ---------- Helpers ----------

function getWorkspaceStub(suffix: string) {
    const prefixed = `${IdTypes.workspace}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        workspaceId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makePush<TBody extends Record<string, unknown>>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
    accountId = null,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
    accountId?: string | null;
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
                    accountId,
                    timestamp_client: new Date().toISOString(),
                    ...body,
                } as any,
            },
        ],
    };
}

async function readRow(
    stub: DurableObjectStub<DjibbList>,
    workspaceId: string
) {
    return runInDurableObject(stub, async (_i, state) => {
        const row = state.storage.sql
            .exec(
                `SELECT name, type, slot, meta, authorization_rules, workspace_id
                 FROM list_elements WHERE id = ?;`,
                workspaceId
            )
            .one();
        return {
            name: row.name as string,
            type: row.type as string,
            slot: row.slot as string | null,
            meta: row.meta
                ? (JSON.parse(row.meta as string) as Record<string, unknown>)
                : null,
            workspace_id: row.workspace_id as string | null,
            authorization_rules: JSON.parse(
                row.authorization_rules as string
            ) as AuthorizationRules,
        };
    });
}

// ---------- createWorkspace ----------

describe('createWorkspace (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('mints a workspace entity with the caller as sole owner', async () => {
        const { workspaceId, stub } = getWorkspaceStub('mkws1');
        const clientGroupID = 'cg_mkws_1';
        const clientID = 'c_mkws_1';
        const ownerA = newId('account');

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'Marketing' },
            }),
        });
        expect(result.error).toBeNull();

        const row = await readRow(stub, workspaceId);
        expect(row.type).toBe('workspace');
        expect(row.name).toBe('Marketing');
        expect(row.slot).toBeNull();
        expect(row.meta).toBeNull();
        // A workspace entity has no parent workspace.
        expect(row.workspace_id).toBeNull();
        expect(row.authorization_rules.authorized_accounts[ownerA]?.role).toBe(
            'owner'
        );
        expect(row.authorization_rules.default_role).toBe('restricted');
    });

    it('honors the optional `slot` arg (e.g. personal_workspace)', async () => {
        const { workspaceId, stub } = getWorkspaceStub('mkwsslot');
        const clientGroupID = 'cg_mkws_slot';
        const clientID = 'c_mkws_slot';
        const ownerA = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: {
                    workspaceId,
                    name: 'Personal',
                    slot: 'personal_workspace',
                },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.slot).toBe('personal_workspace');
    });

    it('is idempotent on duplicate init', async () => {
        const { workspaceId, stub } = getWorkspaceStub('mkws2');
        const clientGroupID = 'cg_mkws_2';
        const clientID = 'c_mkws_2';
        const ownerA = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'First' },
            }),
        });

        // Second push, same target id, different name. createElement
        // detects an existing row and short-circuits — name does not
        // change.
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, name: 'Second' },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.name).toBe('First');
    });
});

// ---------- renameWorkspace ----------

describe('renameWorkspace (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('renames a workspace when caller is admin+', async () => {
        const { workspaceId, stub } = getWorkspaceStub('rnws1');
        const clientGroupID = 'cg_rnws_1';
        const clientID = 'c_rnws_1';
        const ownerA = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'Before' },
            }),
        });

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'renameWorkspace',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, name: 'After' },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.name).toBe('After');
    });

    it('refuses rename from an editor (admin+ gate)', async () => {
        const { workspaceId, stub } = getWorkspaceStub('rnws2');
        const clientGroupID = 'cg_rnws_2';
        const clientID = 'c_rnws_2';
        const ownerA = newId('account');
        const editorE = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'Untouched' },
            }),
        });

        // Editor attempts rename — role gate (`OWNER_ROLES` =
        // admin|owner) rejects.
        await stub.handlePush({
            authorizedAccounts: [{ id: editorE } as any],
            authorizedRole: 'editor',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_editor',
                clientID: 'c_editor',
                name: 'renameWorkspace',
                mutationId: 1,
                accountId: editorE,
                body: { workspaceId, name: 'Hacked' },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.name).toBe('Untouched');
    });

    it('CAS no-ops when expected.name does not match current', async () => {
        const { workspaceId, stub } = getWorkspaceStub('rnws3');
        const clientGroupID = 'cg_rnws_3';
        const clientID = 'c_rnws_3';
        const ownerA = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'Real' },
            }),
        });

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'renameWorkspace',
                mutationId: 2,
                accountId: ownerA,
                body: {
                    workspaceId,
                    name: 'Stale undo',
                    expected: { name: 'Something Else' },
                },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.name).toBe('Real');
    });
});

// ---------- setWorkspaceImage ----------

describe('setWorkspaceImage (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    async function seed(stub: DurableObjectStub<DjibbList>, workspaceId: string, ownerA: string) {
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_seed',
                clientID: 'c_seed',
                name: 'createWorkspace',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId, name: 'Seed' },
            }),
        });
    }

    it('writes meta.image_url; clearing collapses meta back to null', async () => {
        const { workspaceId, stub } = getWorkspaceStub('imgws1');
        const ownerA = newId('account');
        await seed(stub, workspaceId, ownerA);

        // Set
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_img',
                clientID: 'c_img',
                name: 'setWorkspaceImage',
                mutationId: 1,
                accountId: ownerA,
                body: {
                    workspaceId,
                    image: 'https://example.com/avatar.png',
                },
            }),
        });

        let row = await readRow(stub, workspaceId);
        expect(row.meta).toEqual({
            image_url: 'https://example.com/avatar.png',
        });

        // Clear — meta collapses to null since image_url was the only
        // key.
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_img',
                clientID: 'c_img',
                name: 'setWorkspaceImage',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, image: null },
            }),
        });

        row = await readRow(stub, workspaceId);
        expect(row.meta).toBeNull();
    });

    it('refuses image-set from an editor', async () => {
        const { workspaceId, stub } = getWorkspaceStub('imgws2');
        const ownerA = newId('account');
        const editorE = newId('account');
        await seed(stub, workspaceId, ownerA);

        await stub.handlePush({
            authorizedAccounts: [{ id: editorE } as any],
            authorizedRole: 'editor',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_editor_img',
                clientID: 'c_editor_img',
                name: 'setWorkspaceImage',
                mutationId: 1,
                accountId: editorE,
                body: { workspaceId, image: 'https://hax.example/x.png' },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.meta).toBeNull();
    });

    it('CAS no-ops when expected.image does not match current', async () => {
        const { workspaceId, stub } = getWorkspaceStub('imgws3');
        const ownerA = newId('account');
        await seed(stub, workspaceId, ownerA);

        // Stale undo: client thinks current image is 'A', wants to
        // restore to null. Real current image is null (never set), so
        // the CAS check fails and the write is skipped — meta stays
        // null.
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_cas',
                clientID: 'c_cas',
                name: 'setWorkspaceImage',
                mutationId: 1,
                accountId: ownerA,
                body: {
                    workspaceId,
                    image: 'https://will-not-write.example/x.png',
                    expected: { image: 'A' },
                },
            }),
        });

        const row = await readRow(stub, workspaceId);
        expect(row.meta).toBeNull();
    });
});
