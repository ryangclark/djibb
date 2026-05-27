import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import worker from '../src/index';
import { CreateAccount } from '../src/account/service';
import { ID_LENGTH, IdTypes, newId } from '../src/id';
import {
    GetWorkspacesByAccountId,
    mintPersonalWorkspaceEntity,
} from '../src/workspace/service';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

function makeListId(): string {
    return newId('list');
}

function pushUrl(entityId: string, route: 'list' | 'template' = 'list'): string {
    return `${ORIGIN}/${route}/push?id=${encodeURIComponent(entityId)}`;
}

function makeInitListPush(args: {
    listId: string;
    accountId: string | null;
    workspaceId: string | null;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID: 'cg_test',
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: 'c_test',
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId: args.accountId,
                    listId: args.listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: args.workspaceId,
                },
            },
        ],
    };
}

async function postPush(
    entityId: string,
    body: PushRequestV1,
    route: 'list' | 'template' = 'list',
): Promise<Response> {
    const req = new Request(pushUrl(entityId, route), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Host: new URL(ORIGIN).host,
        },
        body: JSON.stringify(body),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

async function getEntityRow(id: string): Promise<any> {
    return env.DJIBB_AUTH.prepare(
        'SELECT * FROM workspace_entities WHERE id = ?',
    )
        .bind(id)
        .first();
}

describe('init reconciliation: anonymous list creation', () => {
    it('inserts a workspace_entities row on first init push', async () => {
        const listId = makeListId();
        const res = await postPush(
            listId,
            makeInitListPush({
                listId,
                accountId: null,
                workspaceId: null,
            }),
        );
        expect(res.status).toBe(200);

        const row = await getEntityRow(listId);
        expect(row).toBeTruthy();
        expect(row.id).toBe(listId);
        expect(row.type).toBe('list');
        expect(row.workspace_id).toBeNull();
        const rules = JSON.parse(row.authorization_rules);
        expect(rules.default_role).toBe('ownerless');
    });

    it('is idempotent on retry', async () => {
        const listId = makeListId();
        const push = makeInitListPush({
            listId,
            accountId: null,
            workspaceId: null,
        });
        const first = await postPush(listId, push);
        expect(first.status).toBe(200);
        const second = await postPush(listId, push);
        expect(second.status).toBe(200);

        const result = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) as n FROM workspace_entities WHERE id = ?',
        )
            .bind(listId)
            .first<{ n: number }>();
        expect(result?.n).toBe(1);
    });
});

describe('init reconciliation: workspace-targeted creation', () => {
    it('rejects when caller cannot claim the accountId (no session)', async () => {
        // ADR 0011 §7b.4: ported off the deleted `CreateWorkspace`
        // service fn. The workspace here is `mintPersonalWorkspaceEntity`'s
        // output — same DO-mutator path the signup flow uses. The
        // invariant is the same: an init push that claims an accountId
        // the session doesn't own is rejected before workspace
        // membership is even consulted.
        const owner = await CreateAccount(env, {
            id: '',
            display_name: 'Owner',
            email: 'owner@example.com',
            email_verified: true,
            flags: null,
            image: null,
            provider_name: 'google',
            provider_client_id: 'g-' + Math.random().toString(36).slice(2),
            user_name: 'owner-' + Math.random().toString(36).slice(2, 8),
            time_created: new Date(),
            time_deleted: null,
            time_updated: new Date(),
        } as any);
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            owner.id,
        );
        const workspaceId = memberships[0]!.workspace.id;

        const listId = makeListId();
        // No session attached → caller can't claim accountId.
        const res = await postPush(
            listId,
            makeInitListPush({
                listId,
                accountId: owner.id,
                workspaceId,
            }),
        );
        expect(res.status).toBe(403);

        const row = await getEntityRow(listId);
        expect(row).toBeNull();
    });
});

describe('init reconciliation: template endpoint', () => {
    it('inserts a template-typed row when init pushed via /template', async () => {
        const templateId = newId('template');
        const res = await postPush(
            templateId,
            makeInitListPush({
                listId: templateId,
                accountId: null,
                workspaceId: null,
            }),
            'template',
        );
        expect(res.status).toBe(200);

        const row = await getEntityRow(templateId);
        expect(row).toBeTruthy();
        expect(row.type).toBe('template');
    });

    it('rejects a list ID pushed against /template', async () => {
        const listId = newId('list');
        const res = await postPush(
            listId,
            makeInitListPush({
                listId,
                accountId: null,
                workspaceId: null,
            }),
            'template',
        );
        expect(res.status).toBe(400);
    });
});

describe('pre-init reads return 404', () => {
    it('GET / on unknown entity is 404', async () => {
        const listId = makeListId();
        const req = new Request(`${ORIGIN}/list?id=${listId}`, {
            headers: { Origin: ORIGIN },
        });
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(404);
    });

    it('POST /push without initList on unknown entity is 404', async () => {
        const listId = makeListId();
        const push: PushRequestV1 = {
            profileID: 'p_test',
            clientGroupID: 'cg_test',
            pushVersion: 1,
            schemaVersion: '1',
            mutations: [
                {
                    clientID: 'c_test',
                    id: 1,
                    name: 'createListItem',
                    timestamp: Date.now(),
                    args: {},
                },
            ],
        };
        const res = await postPush(listId, push);
        expect(res.status).toBe(404);
    });
});
