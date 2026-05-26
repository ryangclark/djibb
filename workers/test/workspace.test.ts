import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import {
    CreateWorkspace,
    GetWorkspaceBySlug,
    GetWorkspacesByAccountId,
    LeaveWorkspace,
    SoftDeleteWorkspace,
    UpdateWorkspace,
} from '../src/workspace/service';
import { GetEntity } from '../src/list/entity';
import type { Account } from '../src/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '', // assigned by CreateAccount
        display_name: 'Test User',
        email: 'test@example.com',
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'google-test-' + Math.random().toString(36).slice(2),
        user_name: 'testuser-' + Math.random().toString(36).slice(2, 8),
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('CreateAccount auto-creates personal workspace', () => {
    it('inserts a personal workspace + owner membership', async () => {
        const account = await CreateAccount(env,
            makeAccount({ display_name: 'Ada Lovelace', user_name: 'ada' })
        );
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        expect(memberships).toHaveLength(1);
        const personal = memberships[0]!;
        expect(personal.workspace.is_personal).toBe(true);
        expect(personal.workspace.name).toBe("Ada Lovelace's space");
        expect(personal.membership.role).toBe('owner');
        expect(personal.workspace.slug.length).toBeGreaterThanOrEqual(3);
    });

    it('falls back to a generated personal- slug when user_name is missing', async () => {
        const account = await CreateAccount(env,
            makeAccount({ display_name: 'No Name', user_name: null })
        );
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        expect(memberships[0]!.workspace.slug).toMatch(/^personal-/);
    });

    // ADR 0011 §Step 6: dual-write — every CreateAccount also mints a
    // workspace entity DO with slot='personal_workspace' at the same id
    // as the legacy `workspaces` row. Step 7 will collapse the two; for
    // now we verify the projection landed in the D1 catalog.
    it('also mints a workspace entity DO with slot=personal_workspace', async () => {
        const account = await CreateAccount(
            env,
            makeAccount({ display_name: 'Grace Hopper', user_name: 'grace' })
        );
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        const legacy = memberships[0]!;

        const entity = await GetEntity(env.DJIBB_AUTH, legacy.workspace.id);
        expect(entity).not.toBeNull();
        expect(entity!.type).toBe('workspace');
        expect(entity!.slot).toBe('personal_workspace');
        expect(entity!.name).toBe("Grace Hopper's space");
        expect(entity!.workspace_id).toBeNull();
        expect(entity!.authorization_rules.authorized_accounts[account.id]?.role).toBe(
            'owner'
        );
        expect(entity!.authorization_rules.default_role).toBe('restricted');
    });

    it('falls back to "Personal" entity name when the legacy name is null', async () => {
        // No display_name → personalNameForAccount returns null → the
        // entity mint substitutes "Personal" (createWorkspace's name is
        // required `min(1)`; null would fail parsing).
        // Empty display_name makes `personalNameForAccount` return null
        // (it only builds "X's space" when there's a non-empty
        // trimmed name); legacy workspace.name lands null, entity
        // mint substitutes "Personal".
        const account = await CreateAccount(
            env,
            makeAccount({ display_name: '', user_name: 'nobody' })
        );
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        const entity = await GetEntity(
            env.DJIBB_AUTH,
            memberships[0]!.workspace.id
        );
        expect(entity!.name).toBe('Personal');
        expect(entity!.slot).toBe('personal_workspace');
    });
});

describe('CreateWorkspace + GetWorkspaceBySlug', () => {
    it('creates a shared workspace with the actor as owner', async () => {
        const account = await CreateAccount(env, makeAccount());
        const workspace = await CreateWorkspace(env.DJIBB_AUTH, account.id, {
            slug: 'team-rocket',
            name: 'Team Rocket 🚀',
        });
        expect(workspace.is_personal).toBe(false);

        const fetched = await GetWorkspaceBySlug(env.DJIBB_AUTH, 'team-rocket');
        expect(fetched.id).toBe(workspace.id);
        expect(fetched.name).toBe('Team Rocket 🚀');

        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        // personal + shared = 2
        expect(memberships).toHaveLength(2);
        const shared = memberships.find(m => !m.workspace.is_personal)!;
        expect(shared.membership.role).toBe('owner');
    });

    it('rejects a duplicate slug', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        await CreateWorkspace(env.DJIBB_AUTH, a1.id, {
            slug: 'shared-one',
            name: 'A',
        });
        await expect(
            CreateWorkspace(env.DJIBB_AUTH, a1.id, {
                slug: 'shared-one',
                name: 'B',
            })
        ).rejects.toThrow(/already in use/i);
    });

    it('rejects reserved slugs', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        await expect(
            CreateWorkspace(env.DJIBB_AUTH, a1.id, {
                slug: 'settings',
                name: 'X',
            })
        ).rejects.toThrow(/reserved/i);
    });
});

describe('LeaveWorkspace', () => {
    it('blocks the last owner from leaving', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        const ws = await CreateWorkspace(env.DJIBB_AUTH, a1.id, {
            slug: 'soloists',
            name: 'Soloists',
        });
        await expect(
            LeaveWorkspace(env.DJIBB_AUTH, a1.id, ws.slug)
        ).rejects.toThrow(/last owner/i);
    });

    it('refuses to leave a personal workspace', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        const memberships = await GetWorkspacesByAccountId(env.DJIBB_AUTH, a1.id);
        const personal = memberships[0]!.workspace;
        await expect(
            LeaveWorkspace(env.DJIBB_AUTH, a1.id, personal.slug)
        ).rejects.toThrow(/personal/i);
    });
});

describe('UpdateWorkspace + SoftDeleteWorkspace', () => {
    it('updates name + slug, then soft-deletes', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        const ws = await CreateWorkspace(env.DJIBB_AUTH, a1.id, {
            slug: 'temp-name',
            name: 'Temp',
        });
        const updated = await UpdateWorkspace(env.DJIBB_AUTH, a1.id, ws.slug, {
            slug: 'forever-name',
            name: 'Forever',
        });
        expect(updated.slug).toBe('forever-name');
        expect(updated.name).toBe('Forever');

        await SoftDeleteWorkspace(env.DJIBB_AUTH, a1.id, 'forever-name');
        await expect(
            GetWorkspaceBySlug(env.DJIBB_AUTH, 'forever-name')
        ).rejects.toThrow();
    });

    it('refuses to delete a personal workspace', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        const memberships = await GetWorkspacesByAccountId(env.DJIBB_AUTH, a1.id);
        const personal = memberships[0]!.workspace;
        await expect(
            SoftDeleteWorkspace(env.DJIBB_AUTH, a1.id, personal.slug)
        ).rejects.toThrow(/personal/i);
    });
});
