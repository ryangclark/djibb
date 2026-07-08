// ADR 0009 §Recipient discovery — the `/invitations` inbox query.
// `ListPendingInvitationsForIdentities` is the read behind
// `GET /a/<suffix>/invitations`: it joins `entity_invitations_index`
// against `workspace_entities` and must surface only invitations that
// are pending, unexpired, addressed to one of the caller's identities,
// and whose target is still live. These tests exercise that SQL against
// the real D1 binding.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { ListPendingInvitationsForIdentities } from '../src/derived-index/d1';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW_SECONDS = 1_700_000_000; // fixed for stability
const WEEK = 7 * 86_400;

const me = 'invitee@example.com';
const stranger = 'someone-else@example.com';

const listId = 'l/list1___aaaaaaaaaaa';
const wsId = 'w/ws1_____aaaaaaaaaaa';
const deletedListId = 'l/deleted_aaaaaaaaaaa';

async function seedEntity(args: {
    id: string;
    type: 'list' | 'template' | 'workspace';
    name: string | null;
    slug: string | null;
    deleted?: boolean;
}): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO workspace_entities (
            id, type, name, slug, authorization_rules,
            time_created, time_updated, time_deleted
         ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
        .bind(
            args.id,
            args.type,
            args.name,
            args.slug,
            NOW_SECONDS,
            NOW_SECONDS,
            args.deleted ? NOW_SECONDS : null,
        )
        .run();
}

async function seedInvite(args: {
    id: string;
    targetId: string;
    targetType: 'list' | 'template' | 'workspace';
    identity: string;
    status: 'pending' | 'accepted' | 'revoked';
    timeCreated?: number;
    timeExpires?: number;
    role?: string;
}): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO entity_invitations_index (
            id, target_id, target_type, identity_kind, identity_value,
            role, inviter_account_id, status, time_created, time_expires
         ) VALUES (?, ?, ?, 'email', ?, ?, 'a/inviter_aaaaaaaaaaaa', ?, ?, ?)`,
    )
        .bind(
            args.id,
            args.targetId,
            args.targetType,
            args.identity,
            args.role ?? 'editor',
            args.status,
            args.timeCreated ?? NOW_SECONDS,
            args.timeExpires ?? NOW_SECONDS + WEEK,
        )
        .run();
}

describe('ListPendingInvitationsForIdentities', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
        // `slug` is NOT NULL (migration 0012); lists default theirs to the
        // id-suffix. The inbox URLs lists/templates by id regardless, but
        // the column is always populated, so seed it.
        await seedEntity({
            id: listId,
            type: 'list',
            name: 'Groceries',
            slug: 'groceries',
        });
        await seedEntity({ id: wsId, type: 'workspace', name: 'Team', slug: 'team' });
        await seedEntity({
            id: deletedListId,
            type: 'list',
            name: 'Gone',
            slug: 'gone',
            deleted: true,
        });
    });

    it('returns pending, unexpired invites for the identity, joined to entity name/slug', async () => {
        await seedInvite({
            id: 'inv/list1_aaaaaaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: me,
            status: 'pending',
            timeCreated: NOW_SECONDS - 100,
        });
        await seedInvite({
            id: 'inv/ws1___aaaaaaaaaaaa',
            targetId: wsId,
            targetType: 'workspace',
            identity: me,
            status: 'pending',
            timeCreated: NOW_SECONDS - 10, // newer → sorts first
            role: 'admin',
        });

        const rows = await ListPendingInvitationsForIdentities(env.DJIBB_AUTH, {
            identityValues: [me],
            nowSeconds: NOW_SECONDS,
        });

        expect(rows).toHaveLength(2);
        // Newest first.
        expect(rows[0]).toMatchObject({
            target_id: wsId,
            target_type: 'workspace',
            name: 'Team',
            slug: 'team',
            role: 'admin',
        });
        expect(rows[1]).toMatchObject({
            target_id: listId,
            target_type: 'list',
            name: 'Groceries',
            slug: 'groceries',
            role: 'editor',
        });
    });

    it('excludes expired, accepted/revoked, other-identity, and soft-deleted-target invites', async () => {
        await seedInvite({
            id: 'inv/expired_aaaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: me,
            status: 'pending',
            timeExpires: NOW_SECONDS - 1, // expired
        });
        await seedInvite({
            id: 'inv/accepted_aaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: me,
            status: 'accepted',
        });
        await seedInvite({
            id: 'inv/revoked_aaaaaaaaa',
            targetId: wsId,
            targetType: 'workspace',
            identity: me,
            status: 'revoked',
        });
        await seedInvite({
            id: 'inv/other___aaaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: stranger, // not one of my identities
            status: 'pending',
        });
        await seedInvite({
            id: 'inv/deltgt__aaaaaaaaa',
            targetId: deletedListId,
            targetType: 'list',
            identity: me,
            status: 'pending', // target soft-deleted
        });

        const rows = await ListPendingInvitationsForIdentities(env.DJIBB_AUTH, {
            identityValues: [me],
            nowSeconds: NOW_SECONDS,
        });
        expect(rows).toEqual([]);
    });

    it('returns nothing when the caller has no verified identities', async () => {
        await seedInvite({
            id: 'inv/list1_aaaaaaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: me,
            status: 'pending',
        });
        const rows = await ListPendingInvitationsForIdentities(env.DJIBB_AUTH, {
            identityValues: [],
            nowSeconds: NOW_SECONDS,
        });
        expect(rows).toEqual([]);
    });

    it('matches across multiple identities', async () => {
        const alt = 'alt@example.com';
        await seedInvite({
            id: 'inv/list1_aaaaaaaaaaaa',
            targetId: listId,
            targetType: 'list',
            identity: me,
            status: 'pending',
        });
        await seedInvite({
            id: 'inv/ws1___aaaaaaaaaaaa',
            targetId: wsId,
            targetType: 'workspace',
            identity: alt,
            status: 'pending',
        });
        const rows = await ListPendingInvitationsForIdentities(env.DJIBB_AUTH, {
            identityValues: [me, alt],
            nowSeconds: NOW_SECONDS,
        });
        expect(rows).toHaveLength(2);
    });
});
