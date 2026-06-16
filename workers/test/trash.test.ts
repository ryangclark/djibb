// ADR 0011 §Step 10b-ui / ADR 0008: tests for the per-account Trash
// query. The endpoint (`GET /a/<suffix>/trash`) is a thin wrapper over
// `ListTrashedEntitiesForAccount`; we test the service function
// directly since the wrapper is identical to `/a/<suffix>/workspaces`
// (same auth, same shape) which already has coverage.
//
// The Trash predicate is:
//   time_deleted IS NOT NULL
//   AND (type = 'workspace' OR cascade_source IS NULL)
//   AND em.role = 'owner'
//
// Each branch of that predicate is one test below.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import {
    EmitEntityMembershipsToCatalog,
    EmitEntitySnapshotToCatalog,
} from '../src/list/entity';
import { ListTrashedEntitiesForAccount } from '../src/catalog/service';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';
import type { Account } from '../src/account';

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
        display_name: 'Test User',
        email: `t-${Math.random().toString(36).slice(2)}@example.com`,
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g-' + Math.random().toString(36).slice(2),
        user_name: null,
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

async function seed({
    type,
    name,
    ownerId,
    role = 'owner',
    time_deleted = null,
    cascade_source = null,
}: {
    type: 'list' | 'template' | 'workspace';
    name: string;
    ownerId: string;
    role?: string;
    time_deleted?: number | null;
    cascade_source?: string | null;
}): Promise<string> {
    const id = newId(
        type === 'workspace' ? 'workspace' : type
    );
    const now = Math.floor(Date.now() / 1000);
    await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, {
        id,
        workspace_id: type === 'workspace' ? null : null,
        type,
        name,
        description: null,
        forked_from_id: null,
        meta: null,
        slot: null,
        cascade_source,
        authorization_rules: {
            authorized_accounts: { [ownerId]: { role: role as any } },
            default_role: 'restricted',
            set_by: 'user',
        },
        time_created: now,
        time_updated: now,
        time_deleted,
        version: 1,
    });
    await EmitEntityMembershipsToCatalog(env.DJIBB_AUTH, {
        entityId: id,
        authorizedAccounts: { [ownerId]: { role } },
        timeUpdated: now,
    });
    return id;
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('ListTrashedEntitiesForAccount', () => {
    it('returns a soft-deleted workspace the actor owns', async () => {
        const me = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        const wsId = await seed({
            type: 'workspace',
            name: 'My WS',
            ownerId: me.id,
            time_deleted: now,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash.map(e => e.id)).toEqual([wsId]);
        expect(trash[0]!.type).toBe('workspace');
        expect(trash[0]!.name).toBe('My WS');
        expect(trash[0]!.time_deleted).not.toBeNull();
    });

    it('returns a user-archived list (cascade_source IS NULL)', async () => {
        const me = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        const id = await seed({
            type: 'list',
            name: 'manually deleted',
            ownerId: me.id,
            time_deleted: now,
            cascade_source: null,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash.map(e => e.id)).toEqual([id]);
    });

    it('excludes a cascade-archived list (cascade_source set)', async () => {
        // The child will come back via cascade-restore when the user
        // restores the workspace; showing it as its own Trash row
        // would invite a per-row Restore that races the workspace
        // restore sweep.
        const me = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        const wsId = await seed({
            type: 'workspace',
            name: 'parent ws',
            ownerId: me.id,
            time_deleted: now,
        });
        await seed({
            type: 'list',
            name: 'cascade-archived child',
            ownerId: me.id,
            time_deleted: now,
            cascade_source: wsId,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash.map(e => e.id)).toEqual([wsId]);
    });

    it('excludes a live (not soft-deleted) entity', async () => {
        const me = await CreateAccount(env, makeAccount());
        await seed({
            type: 'list',
            name: 'live',
            ownerId: me.id,
            time_deleted: null,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash).toEqual([]);
    });

    it('excludes entities the actor does not own (role != owner)', async () => {
        const me = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        // Seeded with role=editor — must not surface in actor's Trash.
        await seed({
            type: 'list',
            name: 'editor sees',
            ownerId: me.id,
            role: 'editor',
            time_deleted: now,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash).toEqual([]);
    });

    it('excludes entities owned by other accounts', async () => {
        const me = await CreateAccount(env, makeAccount());
        const other = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        await seed({
            type: 'list',
            name: 'theirs',
            ownerId: other.id,
            time_deleted: now,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash).toEqual([]);
    });

    it('orders by time_deleted DESC (most recent first)', async () => {
        const me = await CreateAccount(env, makeAccount());
        const now = Math.floor(Date.now() / 1000);
        const olderId = await seed({
            type: 'list',
            name: 'older',
            ownerId: me.id,
            time_deleted: now - 3600,
        });
        const newerId = await seed({
            type: 'list',
            name: 'newer',
            ownerId: me.id,
            time_deleted: now,
        });

        const trash = await ListTrashedEntitiesForAccount(
            env.DJIBB_AUTH,
            me.id
        );
        expect(trash.map(e => e.id)).toEqual([newerId, olderId]);
    });
});
