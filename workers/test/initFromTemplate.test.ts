import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import * as initFromTemplate from '../src/list/mutators/initFromTemplate';

// End-to-end coverage for initFromTemplate (A.8). Scope today: entity
// row creation with `forked_from_id` set; content copy is intentionally
// out of scope (see file docstring). Friction-tier flag is exercised
// by ADR 0005's runtime in B.2.

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

describe('initFromTemplate end-to-end', () => {
    it('creates the list entity with forked_from_id and the supplied name', async () => {
        const { listId, stub } = getListStub('ift1');
        const templateId = newId('template');
        const clientGroupID = 'cg_ift_1';
        const clientID = 'c_ift_1';

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makePush({
                name: 'initFromTemplate',
                clientGroupID,
                clientID,
                args: {
                    listId,
                    templateId,
                    workspaceId: null,
                    name: 'Forked List',
                    description: 'from template X',
                },
                mutationId: 1,
            }),
        });
        expect(result.error).toBeNull();

        const row = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT name, description, forked_from_id, type
                     FROM list_elements WHERE id = ?;`,
                    listId
                )
                .one()
        );
        expect(row.name).toBe('Forked List');
        expect(row.description).toBe('from template X');
        expect(row.forked_from_id).toBe(templateId);
        expect(row.type).toBe('list');
    });

    it("declares archiveList as its inverse (constructive)", () => {
        const listId = newId('list');
        const templateId = newId('template');
        const inv = initFromTemplate.inverse({
            listId,
            templateId,
            workspaceId: null,
            name: 'X',
        });
        expect(inv).toEqual({ name: 'archiveList', args: { listId } });
    });

    it('rejects initFromTemplate for restricted role', async () => {
        const { listId, stub } = getListStub('ift2');
        const templateId = newId('template');

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makePush({
                name: 'initFromTemplate',
                clientGroupID: 'cg_ift_2',
                clientID: 'c_ift_2',
                args: {
                    listId,
                    templateId,
                    workspaceId: null,
                    name: 'Forked',
                },
                mutationId: 1,
            }),
        });
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });
});
