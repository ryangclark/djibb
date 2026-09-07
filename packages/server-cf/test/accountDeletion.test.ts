/**
 * Account (identity) deletion — Phase 1 + the "sudo mode" step-up (GH
 * #58, ADR 0024 §3 withdraw path).
 *
 * Skim `docs/testing.md` before extending — service-level vs E2E, the
 * direct-D1-staging pattern for time-sensitive cases.
 *
 * Coverage, at the substrate level (mirrors `credential.test.ts`) plus
 * the HTTP seam for the routes (mirrors `connect.test.ts`):
 *
 *   1. StampSessionSudo / GetSessionSudo round-trip.
 *   2. SoftDeleteAccountPhase1 cascade — tombstone + revoke-all-creds +
 *      remove-from-sessions (single-account session gone, multi-account
 *      survives with its other account) + drop pending auth.
 *   3. Deleted-identity guards — a live token for a tombstoned account
 *      fails VerifyBearerCredential; GetSessionById drops the tombstone.
 *   4. Re-signup — after delete, the djibb unique index no longer
 *      collides on the same email.
 *   5. POST /auth/sudo/request — session-only; mints a purpose='sudo'
 *      token. Magic sudo-consume stamps the session (and refuses a
 *      mismatched account).
 *   6. POST /auth/account/delete — bearer→401; sudo gate (missing / stale
 *      / wrong-account → sudo_required); success clears the single-account
 *      session's cookie and tombstones; multi-account survives.
 */

import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
    CreateCredential,
    CreateSession,
    GetAccountById,
    GetSessionById,
    GetSessionSudo,
    SoftDeleteAccountPhase1,
    StampSessionSudo,
    VerifyBearerCredential,
} from '../src/auth/d1';
import { hashToken } from '../src/auth/magic';
import { newId } from '@djibb/protocol/id';
import type { Account } from '@djibb/protocol/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

const ALLOWED_ORIGIN = 'http://localhost:5173';
const NOW = 1_700_000_000;

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Direct INSERT into `accounts` — bypasses CreateAccount (which mints a
 * personal-workspace DO) so these tests stay scoped to the auth
 * substrate. Mirrors `credential.test.ts`'s helper.
 */
async function insertAccount(
    overrides: {
        id?: string;
        email?: string | null;
        provider_name?: string;
        provider_client_id?: string;
        time_deleted?: number;
    } = {},
): Promise<string> {
    const id = overrides.id ?? newId('account');
    const email =
        overrides.email === undefined
            ? `t-${Math.random().toString(36).slice(2)}@example.com`
            : overrides.email;
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, flags, image,
            provider_name, provider_client_id, time_created, time_updated,
            time_deleted, user_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id,
            'Test User',
            email,
            1,
            null,
            null,
            overrides.provider_name ?? 'google',
            overrides.provider_client_id ?? 'g-' + Math.random().toString(36).slice(2),
            NOW,
            NOW,
            overrides.time_deleted ?? null,
            null,
        )
        .run();
    return id;
}

/** Create a real session over the given accounts; returns its id. */
async function sessionOver(accountIds: string[]): Promise<string> {
    const accounts: Account[] = [];
    for (const id of accountIds) {
        const a = await GetAccountById(env.DJIBB_AUTH, id);
        if (!a) throw new Error(`no account ${id}`);
        accounts.push(a);
    }
    const session = await CreateSession(env.DJIBB_AUTH, {
        accounts,
        ip_country: '',
    });
    return session.id;
}

async function accountSessionIds(accountId: string): Promise<string[]> {
    const { results } = await env.DJIBB_AUTH.prepare(
        'SELECT session_id FROM AccountSession WHERE account_id = ?',
    )
        .bind(accountId)
        .all<{ session_id: string }>();
    return results.map(r => r.session_id);
}

async function accountRow(accountId: string) {
    return env.DJIBB_AUTH.prepare('SELECT * FROM accounts WHERE id = ?')
        .bind(accountId)
        .first<Record<string, any>>();
}

/** A first-party POST through the full worker (CORS/CSRF + HandleSession). */
async function post(
    path: string,
    opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Response> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
        Host: 'localhost:8787',
    };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const ctx = createExecutionContext();
    const res = await worker.fetch(
        new Request(`http://localhost:8787${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(opts.body ?? {}),
        }),
        env,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
}

function cookieFor(sessionId: string): string {
    return `djibb-session=${sessionId}`;
}

// ─── 1. Sudo freshness round-trip ─────────────────────────────────────────────

describe('StampSessionSudo / GetSessionSudo', () => {
    it('stamps and reads back the moment and account', async () => {
        const accountId = await insertAccount();
        const sessionId = await sessionOver([accountId]);

        expect(await GetSessionSudo(env.DJIBB_AUTH, sessionId)).toEqual({
            time_sudo: null,
            sudo_account_id: null,
        });

        await StampSessionSudo(env.DJIBB_AUTH, { sessionId, accountId, now: NOW });
        expect(await GetSessionSudo(env.DJIBB_AUTH, sessionId)).toEqual({
            time_sudo: NOW,
            sudo_account_id: accountId,
        });
    });

    it('returns null for an unknown session', async () => {
        expect(
            await GetSessionSudo(env.DJIBB_AUTH, newId('session')),
        ).toBeNull();
    });
});

// ─── 2. Phase-1 cascade ───────────────────────────────────────────────────────

describe('SoftDeleteAccountPhase1', () => {
    it('tombstones the account and revokes every live credential', async () => {
        const email = 'cascade@example.com';
        const accountId = await insertAccount({ email });
        const live1 = await CreateCredential(env.DJIBB_AUTH, { accountId });
        const live2 = await CreateCredential(env.DJIBB_AUTH, { accountId });

        await SoftDeleteAccountPhase1(env.DJIBB_AUTH, { accountId, now: NOW });

        expect((await accountRow(accountId))!.time_deleted).toBe(NOW);
        // Both live credentials fail the seam now (revoked).
        expect(
            await VerifyBearerCredential(env.DJIBB_AUTH, live1.token),
        ).toBeNull();
        expect(
            await VerifyBearerCredential(env.DJIBB_AUTH, live2.token),
        ).toBeNull();
    });

    it('deletes a single-account session but keeps a multi-account one (minus the account)', async () => {
        const a = await insertAccount({ email: 'a@example.com' });
        const b = await insertAccount({ email: 'b@example.com' });
        const soloSession = await sessionOver([a]);
        const sharedSession = await sessionOver([a, b]);

        await SoftDeleteAccountPhase1(env.DJIBB_AUTH, { accountId: a, now: NOW });

        // The account is gone from every session.
        expect(await accountSessionIds(a)).toEqual([]);
        // The solo session was reaped; the shared one survives for B.
        expect(await GetSessionById(env.DJIBB_AUTH, soloSession)).toBeNull();
        const shared = await GetSessionById(env.DJIBB_AUTH, sharedSession);
        expect(shared!.accounts.map(x => x.id)).toEqual([b]);
    });

    it('drops the identity’s in-flight connect ceremonies (account-scoped)', async () => {
        const email = 'me@example.com';
        const accountId = await insertAccount({ email });
        const other = await insertAccount({ email: 'other@example.com' });

        // This identity's connect code + pending consent…
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO connect_authorization_codes
                (code_hash, account_id, client_origin, code_challenge, time_created, time_expires)
             VALUES (?, ?, ?, 'chal', ?, ?)`,
        )
            .bind('code-mine', accountId, ALLOWED_ORIGIN, NOW, NOW + 300)
            .run();
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO connect_pending
                (handle_hash, account_id, client_origin, code_challenge, time_created, time_expires)
             VALUES (?, ?, ?, 'chal', ?, ?)`,
        )
            .bind('pending-mine', accountId, ALLOWED_ORIGIN, NOW, NOW + 600)
            .run();
        // …and another account's, which must survive.
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO connect_authorization_codes
                (code_hash, account_id, client_origin, code_challenge, time_created, time_expires)
             VALUES (?, ?, ?, 'chal', ?, ?)`,
        )
            .bind('code-theirs', other, ALLOWED_ORIGIN, NOW, NOW + 300)
            .run();

        await SoftDeleteAccountPhase1(env.DJIBB_AUTH, { accountId, now: NOW });

        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT account_id FROM connect_authorization_codes',
        ).all<{ account_id: string }>();
        expect(codes.results.map(r => r.account_id)).toEqual([other]);
        const pending = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_pending',
        ).first<{ n: number }>();
        expect(pending!.n).toBe(0);
    });

    it('does NOT delete magic-link tokens (email-keyed; would be collateral)', async () => {
        const email = 'shared@example.com';
        const accountId = await insertAccount({ email });
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO magic_link_tokens
                (token_hash, target_email, purpose, time_created, time_expires)
             VALUES (?, ?, 'signin', ?, ?)`,
        )
            .bind(await hashToken('pending'), email, NOW, NOW + 900)
            .run();

        await SoftDeleteAccountPhase1(env.DJIBB_AUTH, { accountId, now: NOW });

        // The token survives — it keys on email, not account, and can only
        // resolve to a live account or a fresh one (never the tombstone).
        const n = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM magic_link_tokens WHERE target_email = ?',
        )
            .bind(email)
            .first<{ n: number }>();
        expect(n!.n).toBe(1);
    });
});

// ─── 3. Deleted-identity guards ───────────────────────────────────────────────

describe('deleted-identity guards', () => {
    it('VerifyBearerCredential rejects a still-live token for a tombstoned account', async () => {
        const accountId = await insertAccount();
        const { token } = await CreateCredential(env.DJIBB_AUTH, { accountId });

        // Tombstone WITHOUT revoking the credential, to isolate the guard
        // from the cascade's revoke-all.
        await env.DJIBB_AUTH.prepare(
            'UPDATE accounts SET time_deleted = ? WHERE id = ?',
        )
            .bind(NOW, accountId)
            .run();

        expect(await VerifyBearerCredential(env.DJIBB_AUTH, token)).toBeNull();
    });

    it('GetSessionById drops a tombstoned account from a live session', async () => {
        const a = await insertAccount({ email: 'a@example.com' });
        const b = await insertAccount({ email: 'b@example.com' });
        const sessionId = await sessionOver([a, b]);

        await env.DJIBB_AUTH.prepare(
            'UPDATE accounts SET time_deleted = ? WHERE id = ?',
        )
            .bind(NOW, a)
            .run();

        const session = await GetSessionById(env.DJIBB_AUTH, sessionId);
        expect(session!.accounts.map(x => x.id)).toEqual([b]);
    });
});

// ─── 4. Re-signup after delete (the unique-index fix) ─────────────────────────

describe('re-signup after delete', () => {
    it('lets a new djibb account reuse the email of a tombstoned one', async () => {
        const email = 'reuse@example.com';
        // A tombstoned djibb-native identity (provider_client_id = email).
        await insertAccount({
            email,
            provider_name: 'djibb',
            provider_client_id: email,
            time_deleted: NOW,
        });

        // A fresh signup with the same email must NOT collide with the
        // tombstone (partial unique index now excludes time_deleted rows).
        await expect(
            insertAccount({
                email,
                provider_name: 'djibb',
                provider_client_id: email,
            }),
        ).resolves.toBeDefined();

        // …but a *second live* djibb row on that email is still forbidden.
        await expect(
            insertAccount({
                email,
                provider_name: 'djibb',
                provider_client_id: email,
            }),
        ).rejects.toBeTruthy();
    });
});

// ─── 5. Sudo step-up over HTTP ────────────────────────────────────────────────

describe('POST /auth/sudo/request', () => {
    it('is session-only (anonymous → 401)', async () => {
        const res = await post('/auth/sudo/request');
        expect(res.status).toBe(401);
    });

    it('mints a purpose=sudo token for the session account', async () => {
        const email = 'sudo@example.com';
        const accountId = await insertAccount({ email });
        const sessionId = await sessionOver([accountId]);

        const res = await post('/auth/sudo/request', {
            cookie: cookieFor(sessionId),
        });
        expect(res.status).toBe(200);

        const row = await env.DJIBB_AUTH.prepare(
            'SELECT purpose FROM magic_link_tokens WHERE target_email = ?',
        )
            .bind(email)
            .first<{ purpose: string }>();
        expect(row!.purpose).toBe('sudo');
    });
});

describe('magic sudo-consume stamps the session', () => {
    async function seedSudoToken(email: string, raw: string) {
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO magic_link_tokens
                (token_hash, target_email, purpose, time_created, time_expires)
             VALUES (?, ?, 'sudo', ?, ?)`,
        )
            .bind(await hashToken(raw), email, NOW, Math.floor(Date.now() / 1000) + 900)
            .run();
    }

    it('stamps the calling session sudo-fresh', async () => {
        const email = 'stamp@example.com';
        const accountId = await insertAccount({ email });
        const sessionId = await sessionOver([accountId]);
        await seedSudoToken(email, 'good-sudo-token');

        const res = await post('/auth/magic/consume', {
            cookie: cookieFor(sessionId),
            body: { token: 'good-sudo-token' },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { redirect: string };
        expect(json.redirect).toBe(`${ALLOWED_ORIGIN}/accounts?sudo=ok`);

        const sudo = await GetSessionSudo(env.DJIBB_AUTH, sessionId);
        expect(sudo!.sudo_account_id).toBe(accountId);
        expect(sudo!.time_sudo).not.toBeNull();
        // No new session cookie: the step-up doesn't mint one.
        expect(res.headers.get('set-cookie') ?? '').not.toContain('djibb-session');
    });

    it('refuses to stamp when the token email is not in the session', async () => {
        const accountId = await insertAccount({ email: 'in@example.com' });
        const sessionId = await sessionOver([accountId]);
        await seedSudoToken('someone-else@example.com', 'mismatch-token');

        const res = await post('/auth/magic/consume', {
            cookie: cookieFor(sessionId),
            body: { token: 'mismatch-token' },
        });
        expect(res.status).toBe(400);
        expect(await GetSessionSudo(env.DJIBB_AUTH, sessionId)).toEqual({
            time_sudo: null,
            sudo_account_id: null,
        });
    });

    it('does NOT burn the token when clicked on the wrong device (retryable)', async () => {
        const email = 'retry@example.com';
        const accountId = await insertAccount({ email });
        const sessionId = await sessionOver([accountId]);
        await seedSudoToken(email, 'retry-token');

        // Wrong device: no session cookie → refused, token untouched.
        const wrong = await post('/auth/magic/consume', {
            body: { token: 'retry-token' },
        });
        expect(wrong.status).toBe(400);
        expect(await GetSessionSudo(env.DJIBB_AUTH, sessionId)).toEqual({
            time_sudo: null,
            sudo_account_id: null,
        });

        // Same link, now on the signed-in device → completes.
        const right = await post('/auth/magic/consume', {
            cookie: cookieFor(sessionId),
            body: { token: 'retry-token' },
        });
        expect(right.status).toBe(200);
        expect(
            (await GetSessionSudo(env.DJIBB_AUTH, sessionId))!.sudo_account_id,
        ).toBe(accountId);
    });
});

// ─── 6. POST /auth/account/delete ─────────────────────────────────────────────

describe('POST /auth/account/delete', () => {
    it('rejects a bearer credential (session-only)', async () => {
        const accountId = await insertAccount();
        const { token } = await CreateCredential(env.DJIBB_AUTH, { accountId });

        const res = await post('/auth/account/delete', {
            bearer: token,
            body: { account_id: accountId },
        });
        expect(res.status).toBe(401);
    });

    it('requires a fresh, same-account sudo (missing → sudo_required)', async () => {
        const accountId = await insertAccount();
        const sessionId = await sessionOver([accountId]);

        const res = await post('/auth/account/delete', {
            cookie: cookieFor(sessionId),
            body: { account_id: accountId },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'sudo_required' });
        // Nothing deleted.
        expect((await accountRow(accountId))!.time_deleted).toBeNull();
    });

    it('rejects a stale sudo stamp', async () => {
        const accountId = await insertAccount();
        const sessionId = await sessionOver([accountId]);
        // Stamp far in the past (outside the 5-minute window).
        await StampSessionSudo(env.DJIBB_AUTH, {
            sessionId,
            accountId,
            now: Math.floor(Date.now() / 1000) - 3600,
        });

        const res = await post('/auth/account/delete', {
            cookie: cookieFor(sessionId),
            body: { account_id: accountId },
        });
        expect(res.status).toBe(403);
    });

    it('rejects sudo stamped for a different account', async () => {
        const a = await insertAccount({ email: 'a@example.com' });
        const b = await insertAccount({ email: 'b@example.com' });
        const sessionId = await sessionOver([a, b]);
        await StampSessionSudo(env.DJIBB_AUTH, {
            sessionId,
            accountId: b,
            now: Math.floor(Date.now() / 1000),
        });

        const res = await post('/auth/account/delete', {
            cookie: cookieFor(sessionId),
            body: { account_id: a },
        });
        expect(res.status).toBe(403);
        // The load-bearing safety property (review of #61, finding #1): a sudo
        // stamped for one account can NEVER delete another. Assert the outcome,
        // not just the status — account `a` must be fully untouched.
        expect(await res.json()).toEqual({ error: 'sudo_required' });
        expect((await accountRow(a))!.time_deleted).toBeNull();
    });

    it('deletes the identity and clears the cookie for a single-account session', async () => {
        const email = 'goodbye@example.com';
        const accountId = await insertAccount({ email });
        const sessionId = await sessionOver([accountId]);
        await StampSessionSudo(env.DJIBB_AUTH, {
            sessionId,
            accountId,
            now: Math.floor(Date.now() / 1000),
        });

        const res = await post('/auth/account/delete', {
            cookie: cookieFor(sessionId),
            body: { account_id: accountId },
        });
        expect(res.status).toBe(204);
        // Cookie cleared.
        const setCookie = res.headers.getSetCookie().join('\n');
        expect(setCookie).toContain('djibb-session=;');
        // Tombstoned + session reaped.
        expect((await accountRow(accountId))!.time_deleted).not.toBeNull();
        expect(await GetSessionById(env.DJIBB_AUTH, sessionId)).toBeNull();
    });

    it('keeps a multi-account session alive, minus the deleted account', async () => {
        const a = await insertAccount({ email: 'a@example.com' });
        const b = await insertAccount({ email: 'b@example.com' });
        const sessionId = await sessionOver([a, b]);
        await StampSessionSudo(env.DJIBB_AUTH, {
            sessionId,
            accountId: a,
            now: Math.floor(Date.now() / 1000),
        });

        const res = await post('/auth/account/delete', {
            cookie: cookieFor(sessionId),
            body: { account_id: a },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { accounts: Array<{ id: string }> };
        expect(json.accounts.map(x => x.id)).toEqual([b]);

        const session = await GetSessionById(env.DJIBB_AUTH, sessionId);
        expect(session!.accounts.map(x => x.id)).toEqual([b]);
    });
});
