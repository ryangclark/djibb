// ADR 0009 §"Shared with me — v1 D1". `ListSharedWithAccount` is the
// read behind `GET /a/<suffix>/shared`: lists/templates the account holds
// a direct grant on, but doesn't own and isn't already covered by a
// workspace membership. These tests pin the inclusion/exclusion rules
// against the real D1 binding.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { ListSharedWithAccount } from '../src/catalog/service';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW = 1_700_000_000;

const me = 'a/me______aaaaaaaaaaa';
const myWorkspace = 'w/mine____aaaaaaaaaaa';
const othersWorkspace = 'w/alice___aaaaaaaaaaa';

async function seedEntity(args: {
    id: string;
    type: 'list' | 'template' | 'workspace';
    name: string | null;
    workspaceId?: string | null;
    deleted?: boolean;
    timeUpdated?: number;
}): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO workspace_entities (
            id, type, name, slug, workspace_id, authorization_rules,
            time_created, time_updated, time_deleted
         ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
        .bind(
            args.id,
            args.type,
            args.name,
            args.id.slice(args.id.indexOf('/') + 1), // slug = id suffix
            args.workspaceId ?? null,
            NOW,
            args.timeUpdated ?? NOW,
            args.deleted ? NOW : null,
        )
        .run();
}

async function seedMembership(
    accountId: string,
    entityId: string,
    role: string,
): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO entity_memberships (account_id, entity_id, role, time_updated)
         VALUES (?, ?, ?, ?)`,
    )
        .bind(accountId, entityId, role, NOW)
        .run();
}

describe('ListSharedWithAccount', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('includes a granted list/template not covered by a workspace membership', async () => {
        // A list Alice shared with me, living in her workspace (which I'm
        // not a member of).
        await seedEntity({
            id: 'l/shared__aaaaaaaaaaa',
            type: 'list',
            name: 'Weekend BBQ',
            workspaceId: othersWorkspace,
            timeUpdated: NOW - 10,
        });
        await seedMembership(me, 'l/shared__aaaaaaaaaaa', 'editor');
        // A template shared with me with no workspace at all.
        await seedEntity({
            id: 't/tmpl____aaaaaaaaaaa',
            type: 'template',
            name: 'Packing list',
            workspaceId: null,
            timeUpdated: NOW - 5, // newer → first
        });
        await seedMembership(me, 't/tmpl____aaaaaaaaaaa', 'viewer');

        const rows = await ListSharedWithAccount(env.DJIBB_AUTH, me);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            id: 't/tmpl____aaaaaaaaaaa',
            type: 'template',
            name: 'Packing list',
            role: 'viewer',
        });
        expect(rows[1]).toMatchObject({
            id: 'l/shared__aaaaaaaaaaa',
            type: 'list',
            role: 'editor',
        });
    });

    it('excludes owned, pending (restricted), ownerless, workspaces, and soft-deleted', async () => {
        await seedEntity({ id: 'l/mine____aaaaaaaaaaa', type: 'list', name: 'Mine' });
        await seedMembership(me, 'l/mine____aaaaaaaaaaa', 'owner');

        await seedEntity({ id: 'l/pending_aaaaaaaaaaa', type: 'list', name: 'Pending' });
        await seedMembership(me, 'l/pending_aaaaaaaaaaa', 'restricted');

        await seedEntity({ id: 'l/boot____aaaaaaaaaaa', type: 'list', name: 'Boot' });
        await seedMembership(me, 'l/boot____aaaaaaaaaaa', 'ownerless');

        await seedEntity({
            id: 'w/ws______aaaaaaaaaaa',
            type: 'workspace',
            name: 'A workspace',
        });
        await seedMembership(me, 'w/ws______aaaaaaaaaaa', 'admin');

        await seedEntity({
            id: 'l/deleted_aaaaaaaaaaa',
            type: 'list',
            name: 'Deleted',
            workspaceId: othersWorkspace,
            deleted: true,
        });
        await seedMembership(me, 'l/deleted_aaaaaaaaaaa', 'editor');

        const rows = await ListSharedWithAccount(env.DJIBB_AUTH, me);
        expect(rows).toEqual([]);
    });

    it('excludes a granted entity inside a workspace the account belongs to', async () => {
        // I'm a member of myWorkspace…
        await seedEntity({
            id: myWorkspace,
            type: 'workspace',
            name: 'My team',
        });
        await seedMembership(me, myWorkspace, 'editor');
        // …and I also hold a direct grant on a list inside it. It shows in
        // the workspace view, so it must NOT double-show here.
        await seedEntity({
            id: 'l/inws____aaaaaaaaaaa',
            type: 'list',
            name: 'Team list',
            workspaceId: myWorkspace,
        });
        await seedMembership(me, 'l/inws____aaaaaaaaaaa', 'editor');

        const rows = await ListSharedWithAccount(env.DJIBB_AUTH, me);
        expect(rows).toEqual([]);
    });
});
