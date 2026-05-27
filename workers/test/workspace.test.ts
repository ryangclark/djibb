import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import { GetWorkspacesByAccountId } from '../src/workspace/service';
import { GetEntity } from '../src/list/entity';
import type { Account } from '../src/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ADR 0011 §7b.4: the legacy `CreateWorkspace`, `UpdateWorkspace`,
// `SoftDeleteWorkspace`, `LeaveWorkspace`, `GetWorkspaceBySlug`
// describes that lived here have been deleted. The DO mutators that
// replaced them (`createWorkspace`, `renameWorkspace`,
// `setWorkspaceImage`) are covered by `workspaceMutators.test.ts`;
// `changeMemberRole` / `removeMember` / `leaveMember` ship without
// dedicated worker-side test coverage yet — that gap is tracked
// separately. What remains here is the personal-workspace mint path
// (CreateAccount → mintPersonalWorkspaceEntity → entity_memberships).

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
    it('creates a personal workspace entity with the actor as owner', async () => {
        // ADR 0011 §7b.1: legacy `workspaces`/`AccountWorkspace`
        // dual-write was removed; the personal workspace lives entirely
        // as a DjibbList entity DO + projection rows. Membership reads
        // now come from `entity_memberships`.
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
        // Slugs are postponed (ADR 0011 §7b.2): the projection emits
        // an id-derived placeholder. No `personal-` prefix anymore.
        expect(personal.workspace.slug.length).toBeGreaterThanOrEqual(3);
    });

    // ADR 0011 §Step 7b.1: every CreateAccount mints a workspace entity
    // DO with slot='personal_workspace'. Verifies the entity row landed
    // in the D1 catalog (the projection is post-commit-emitted by the
    // DO; see emitEntitySnapshot in list/durable_object.ts).
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

