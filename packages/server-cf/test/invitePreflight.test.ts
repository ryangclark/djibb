// ADR 0009 Slice 2.5: HTTP-boundary preflight tests for
// `inviteByIdentity`. The DO is single-entity and has no synchronous
// D1 access during a push, so the per-inviter rate limit, outstanding
// cap, and identity-resolution checks (already-a-member, self-invite)
// must live above it. This file exercises the pure `preflightInvite-
// ByIdentity` function against the real D1 binding so the SQL queries
// in `CountInvitesByInviterSince` and `CountOutstandingInvitesByInviter`
// are exercised too.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import {
    CountInvitesByInviterSince,
    CountOutstandingInvitesByInviter,
} from '../src/derived-index/d1';
import {
    INVITE_MAX_OUTSTANDING_PER_INVITER,
    INVITE_MAX_PER_INVITER_PER_HOUR,
    preflightInviteByIdentity,
    type InvitePreflightDeps,
} from '../src/list/invitations';
import { GetAccountByEmail } from '../src/account/service';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW_SECONDS = 1_700_000_000; // Mon 2023-11-14, fixed for stability

const inviterAccountId = 'a/inviter_aaaaaaaaaaaa';
const otherSessionAccountId = 'a/other___aaaaaaaaaaaa';
const targetEmail = 'invitee@example.com';
const targetAccountId = 'a/invitee_aaaaaaaaaaaa';

const baseRules: AuthorizationRules = {
    authorized_accounts: {
        [inviterAccountId]: { role: 'owner' },
    },
    default_role: 'restricted',
    set_by: 'user',
};

function makeDeps(): InvitePreflightDeps {
    const d1 = env.DJIBB_AUTH;
    return {
        countInvitesByInviterSince: (a, since) =>
            CountInvitesByInviterSince(d1, a, since),
        countOutstandingInvitesByInviter: a =>
            CountOutstandingInvitesByInviter(d1, a),
        getAccountIdByEmail: async email => {
            if (!email) return null;
            const account = await GetAccountByEmail(d1, email);
            return account?.id ?? null;
        },
    };
}

async function seedAccountWithEmail(id: string, email: string): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, provider_name,
            provider_client_id, time_created, time_updated
         ) VALUES (?, ?, ?, 1, 'djibb', ?, ?, ?)`,
    )
        .bind(id, 'Test', email, `client_${id}`, NOW_SECONDS, NOW_SECONDS)
        .run();
}

async function seedIndexRow(args: {
    inviter: string;
    timeCreated: number;
    status: 'pending' | 'accepted' | 'revoked';
    identityValue: string;
}): Promise<void> {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO entity_invitations_index (
            id, target_id, target_type, identity_kind, identity_value,
            role, inviter_account_id, status, time_created, time_expires
         ) VALUES (?, ?, 'list', 'email', ?, 'editor', ?, ?, ?, ?)`,
    )
        .bind(
            `inv/${args.identityValue.slice(0, 18).padEnd(18, 'x')}`,
            'l/seed___aaaaaaaaaaaa',
            args.identityValue,
            args.inviter,
            args.status,
            args.timeCreated,
            args.timeCreated + 7 * 86_400,
        )
        .run();
}

describe('preflightInviteByIdentity', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('passes for a first invite from an authorized session', async () => {
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId, otherSessionAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result).toEqual({ ok: true });
    });

    it('rejects when inviter_account_id is missing (unauthenticated)', async () => {
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: null,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('unauthenticated_inviter');
    });

    it('rejects when inviter account is not in the session', async () => {
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [otherSessionAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('session_mismatch');
    });

    it('rejects when the entity has no authorization_rules (pre-init)', async () => {
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: null,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('entity_missing');
    });

    it('rejects when hourly send count is at the cap', async () => {
        for (let i = 0; i < INVITE_MAX_PER_INVITER_PER_HOUR; i++) {
            await seedIndexRow({
                inviter: inviterAccountId,
                timeCreated: NOW_SECONDS - 10 * i, // all within last hour
                status: i % 2 === 0 ? 'pending' : 'revoked', // status-agnostic
                identityValue: `prev${i}@example.com`,
            });
        }
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('rate_limit_hour');
    });

    it('counts only rows inside the hour window for rate limit', async () => {
        // Two rows just outside the window: should NOT trip the limit.
        // Cap is 10/hr; we seed exactly 9 in-window + 5 stale.
        for (let i = 0; i < 9; i++) {
            await seedIndexRow({
                inviter: inviterAccountId,
                timeCreated: NOW_SECONDS - 60 * i, // last hour
                status: 'pending',
                identityValue: `recent${i}@example.com`,
            });
        }
        for (let i = 0; i < 5; i++) {
            await seedIndexRow({
                inviter: inviterAccountId,
                timeCreated: NOW_SECONDS - 60 * 60 - 60 - i, // > 1 hour ago
                status: 'revoked',
                identityValue: `stale${i}@example.com`,
            });
        }
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        // 9 in-window invites + outstanding cap (9) < 25 → passes
        expect(result).toEqual({ ok: true });
    });

    it('rejects when outstanding-pending count is at the cap', async () => {
        // Cap is 25 outstanding (status='pending'). Seed 25 pending rows
        // OLDER than the rate-limit window so the hourly gate doesn't
        // fire first; only the outstanding gate trips.
        const ancient = NOW_SECONDS - 24 * 60 * 60;
        for (let i = 0; i < INVITE_MAX_OUTSTANDING_PER_INVITER; i++) {
            await seedIndexRow({
                inviter: inviterAccountId,
                timeCreated: ancient - i,
                status: 'pending',
                identityValue: `out${i}@example.com`,
            });
        }
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('outstanding_cap');
    });

    it('rejects self-invite (email resolves to inviter account)', async () => {
        await seedAccountWithEmail(inviterAccountId, 'me@example.com');
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: 'ME@example.com', // case-insensitive
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('self_invite');
    });

    it('rejects "already a member" when target has an explicit grant', async () => {
        await seedAccountWithEmail(targetAccountId, targetEmail);
        const rules: AuthorizationRules = {
            ...baseRules,
            authorized_accounts: {
                ...baseRules.authorized_accounts,
                [targetAccountId]: { role: 'editor' },
            },
        };
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: rules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('already_member');
    });

    it('passes when the email maps to an account NOT in the rules', async () => {
        // The invitee has a djibb account, but no per-entity grant. The
        // preflight v1 intentionally does NOT block here — workspace-
        // inherited access doesn't count as "already a member" for
        // invite purposes.
        await seedAccountWithEmail(targetAccountId, targetEmail);
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: targetEmail,
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result).toEqual({ ok: true });
    });

    it('passes when the email does not map to any djibb account', async () => {
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: 'stranger@example.com',
            authorization_rules: baseRules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result).toEqual({ ok: true });
    });

    it('normalizes the identity before resolving the account', async () => {
        await seedAccountWithEmail(targetAccountId, targetEmail);
        const rules: AuthorizationRules = {
            ...baseRules,
            authorized_accounts: {
                ...baseRules.authorized_accounts,
                [targetAccountId]: { role: 'viewer' },
            },
        };
        const result = await preflightInviteByIdentity(makeDeps(), {
            inviter_account_id: inviterAccountId,
            identity_kind: 'email',
            identity_value: '  Invitee@EXAMPLE.com  ', // whitespace + case
            authorization_rules: rules,
            sessionAccountIds: [inviterAccountId],
            nowSeconds: NOW_SECONDS,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('already_member');
    });
});
