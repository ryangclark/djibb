import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import { GetEntity, defaultSlugForId } from '../src/list/entity';
import { GetWorkspacesByAccountId } from '../src/workspace/service';
import type { Account } from '../src/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ADR 0011 §Step 7b.5: slugs return on the entity catalog.
//
// This file covers the schema-level invariants:
//   - Every entity row carries a slug from birth (NOT NULL).
//   - Slug defaults to the id suffix when the DO doesn't emit one.
//   - UNIQUE(type, slug) namespaces slugs per entity type — different
//     types can share a slug string; same type cannot.
//
// The mutator + preflight surface (`setWorkspaceSlug`) lands in 7b.5b
// and gets its own test file. What's here is just the projection
// arbitration that the preflight depends on.

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
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

describe('entity slug projection', () => {
    it('emits slug = id-suffix when no DO slug is present', async () => {
        // Signup mints a personal workspace via mintPersonalWorkspaceEntity
        // → handlePush(createWorkspace), which defaults slug to the
        // id suffix. The projection writer carries that through.
        const account = await CreateAccount(env, makeAccount());
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        const workspaceId = memberships[0]!.workspace.id;
        const entity = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(entity).not.toBeNull();
        expect(entity!.slug).toBe(defaultSlugForId(workspaceId));
    });

    it('UNIQUE(type, slug) rejects a duplicate slug within the same type', async () => {
        const account = await CreateAccount(env, makeAccount());
        const memberships = await GetWorkspacesByAccountId(
            env.DJIBB_AUTH,
            account.id
        );
        const existingSlug = memberships[0]!.workspace.slug;

        // Try to write another workspace row claiming the same slug.
        // The projection write should fail with a UNIQUE constraint
        // violation — this is the cross-DO arbitration site that
        // setWorkspaceSlug's preflight will consult before letting a
        // mutator commit.
        await expect(
            env.DJIBB_AUTH.prepare(
                `INSERT INTO workspace_entities
                    (id, workspace_id, type, name, description, forked_from_id,
                     meta, slug, slot, authorization_rules, time_created,
                     time_updated, time_deleted, version)
                 VALUES (?, NULL, 'workspace', 'collider', NULL, NULL,
                     NULL, ?, NULL, '{}', 0, 0, NULL, 1)`
            )
                .bind(
                    'w/' + 'x'.repeat(21),
                    existingSlug
                )
                .run()
        ).rejects.toThrow(/UNIQUE|constraint/i);
    });

    it('UNIQUE(type, slug) allows the same slug across different entity types', async () => {
        // 'myteam' as both a workspace slug and a list slug must coexist
        // — that's the entire point of the composite UNIQUE index. URL
        // routing already disambiguates by prefix (/w/, /l/, /t/).
        const workspaceRow = {
            id: 'w/' + 'a'.repeat(21),
            type: 'workspace',
            slug: 'myteam',
        };
        const listRow = {
            id: 'l/' + 'b'.repeat(21),
            type: 'list',
            slug: 'myteam',
        };

        for (const row of [workspaceRow, listRow]) {
            await env.DJIBB_AUTH.prepare(
                `INSERT INTO workspace_entities
                    (id, workspace_id, type, name, description, forked_from_id,
                     meta, slug, slot, authorization_rules, time_created,
                     time_updated, time_deleted, version)
                 VALUES (?, NULL, ?, 'myteam', NULL, NULL, NULL, ?,
                     NULL, '{}', 0, 0, NULL, 1)`
            )
                .bind(row.id, row.type, row.slug)
                .run();
        }

        const result = await env.DJIBB_AUTH.prepare(
            `SELECT type, slug FROM workspace_entities WHERE slug = 'myteam'`
        ).all();
        expect(result.results).toHaveLength(2);
        const types = (result.results as any[]).map(r => r.type).sort();
        expect(types).toEqual(['list', 'workspace']);
    });
});
