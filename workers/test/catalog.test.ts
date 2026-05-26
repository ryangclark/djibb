import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import { EmitEntitySnapshotToCatalog } from '../src/list/entity';
import { ListOwnedEntities } from '../src/catalog/service';
import { newId } from '../src/id';
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

async function seedEntity({
    type,
    ownerId,
    name,
}: {
    type: 'list' | 'template';
    ownerId: string | null;
    name: string;
}): Promise<string> {
    const id = newId(type);
    const now = Math.floor(Date.now() / 1000);
    await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, {
        id,
        workspace_id: null,
        type,
        name,
        description: null,
        forked_from_id: null,
        slot: null,
        authorization_rules: ownerId
            ? {
                  authorized_accounts: { [ownerId]: { role: 'owner' } },
                  default_role: 'restricted',
                  set_by: 'user',
              }
            : {
                  authorized_accounts: {},
                  default_role: 'ownerless',
                  set_by: 'defaults',
              },
        time_created: now,
        time_updated: now,
        time_deleted: null,
        version: 1,
    });
    return id;
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('ListOwnedEntities', () => {
    it('returns owner-only entities for the account, lists and templates', async () => {
        const me = await CreateAccount(env, makeAccount());
        const listId = await seedEntity({
            type: 'list',
            ownerId: me.id,
            name: 'My List',
        });
        const templateId = await seedEntity({
            type: 'template',
            ownerId: me.id,
            name: 'My Template',
        });

        const result = await ListOwnedEntities(env.DJIBB_AUTH, me.id);
        const ids = result.map(e => e.id).sort();
        expect(ids).toEqual([listId, templateId].sort());
        const list = result.find(e => e.id === listId);
        expect(list?.type).toBe('list');
        expect(list?.name).toBe('My List');
        const template = result.find(e => e.id === templateId);
        expect(template?.type).toBe('template');
    });

    it('excludes entities owned by other accounts', async () => {
        const me = await CreateAccount(env, makeAccount());
        const other = await CreateAccount(env, makeAccount());
        await seedEntity({ type: 'list', ownerId: other.id, name: 'Theirs' });

        const result = await ListOwnedEntities(env.DJIBB_AUTH, me.id);
        expect(result).toEqual([]);
    });

    it('excludes ownerless entities', async () => {
        const me = await CreateAccount(env, makeAccount());
        await seedEntity({ type: 'list', ownerId: null, name: 'Anon' });

        const result = await ListOwnedEntities(env.DJIBB_AUTH, me.id);
        expect(result).toEqual([]);
    });

    it('excludes soft-deleted entities', async () => {
        const me = await CreateAccount(env, makeAccount());
        const id = await seedEntity({
            type: 'list',
            ownerId: me.id,
            name: 'Deleted',
        });
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET time_deleted = ? WHERE id = ?',
        )
            .bind(Math.floor(Date.now() / 1000), id)
            .run();

        const result = await ListOwnedEntities(env.DJIBB_AUTH, me.id);
        expect(result).toEqual([]);
    });

    it('orders by time_updated DESC', async () => {
        const me = await CreateAccount(env, makeAccount());
        const oldId = await seedEntity({
            type: 'list',
            ownerId: me.id,
            name: 'Old',
        });
        const newId_ = await seedEntity({
            type: 'list',
            ownerId: me.id,
            name: 'New',
        });
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET time_updated = ? WHERE id = ?',
        )
            .bind(Math.floor(Date.now() / 1000) - 3600, oldId)
            .run();

        const result = await ListOwnedEntities(env.DJIBB_AUTH, me.id);
        expect(result.map(e => e.id)).toEqual([newId_, oldId]);
    });
});

// Version-guarded upsert per ADR 0007. The post-commit emit path is
// the only writer today, but the reconciliation sweeper will become a
// second concurrent writer; the guard ensures a stale emit cannot
// roll back a fresh one.
describe('EmitEntitySnapshotToCatalog (version guard)', () => {
    async function read(id: string) {
        const row = await env.DJIBB_AUTH.prepare(
            'SELECT name, version FROM workspace_entities WHERE id = ?',
        )
            .bind(id)
            .first<{ name: string; version: number }>();
        return row;
    }

    function makeSnapshot(id: string, name: string, version: number) {
        const now = Math.floor(Date.now() / 1000);
        return {
            id,
            workspace_id: null,
            type: 'list' as const,
            name,
            description: null,
            forked_from_id: null,
            slot: null,
            authorization_rules: {
                authorized_accounts: {},
                default_role: 'ownerless' as const,
                set_by: 'defaults' as const,
            },
            time_created: now,
            time_updated: now,
            time_deleted: null,
            version,
        };
    }

    it('applies the update when excluded.version > current version', async () => {
        const id = newId('list');
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'v1', 1));
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'v2', 2));
        const row = await read(id);
        expect(row?.name).toBe('v2');
        expect(row?.version).toBe(2);
    });

    it('applies the update when excluded.version == current version (retry-safe)', async () => {
        // Re-emitting the same version (e.g. sweeper retry) replays
        // current state. Useful for content-only repairs without
        // bumping the DO's version counter.
        const id = newId('list');
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'v1', 1));
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'v1-replay', 1));
        const row = await read(id);
        expect(row?.name).toBe('v1-replay');
        expect(row?.version).toBe(1);
    });

    it('silently no-ops when excluded.version < current version', async () => {
        // Sweeper reads DO version 5 → fresh mutation lands version 6
        // and emits → sweeper's late emit (version 5) MUST NOT clobber.
        const id = newId('list');
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'fresh', 6));
        await EmitEntitySnapshotToCatalog(env.DJIBB_AUTH, makeSnapshot(id, 'stale', 5));
        const row = await read(id);
        expect(row?.name).toBe('fresh');
        expect(row?.version).toBe(6);
    });
});
