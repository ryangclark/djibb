/**
 * The request→Account seam: `resolvePrincipal` (ADR 0022 §2, candidate 1).
 *
 * One seam resolves every client to a single {@link RequestPrincipal} —
 * the discriminated union (`anonymous | session | credential`) the rest of
 * the worker reads. These tests pin the *precedence* logic that used to
 * live, untested, inside the Hono middleware:
 *
 *   - a valid cookie wins, and never consults the bearer header;
 *   - a present-but-invalid cookie short-circuits to anonymous — it does
 *     NOT fall through to a bearer token (a stale browser cookie must not
 *     be silently upgraded to API auth);
 *   - only an absent/blank cookie tries the bearer header;
 *   - everything else is anonymous.
 *
 * Plus the cookie directive (`none|refresh|clear`) the thin middleware
 * applies — `refresh` mid-life, `clear` on an invalid cookie.
 */
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolvePrincipal } from '../src/auth/principal';
import { CreateCredential } from '../src/auth/d1';
import { CreateSession } from '../src/auth/d1';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

async function insertAccount(): Promise<string> {
    const id = newId('account');
    const now = Math.floor(Date.now() / 1000);
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, flags, image,
            provider_name, provider_client_id, time_created, time_updated, user_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id, 'Test User', `t-${Math.random().toString(36).slice(2)}@example.com`,
            1, null, null, 'google', 'g-' + Math.random().toString(36).slice(2),
            now, now, null,
        )
        .run();
    return id;
}

/** Mint a real session row and return its id + the account it holds. */
async function makeSession(): Promise<{ sessionId: string; accountId: string }> {
    const accountId = await insertAccount();
    const account = (
        await env.DJIBB_AUTH.prepare('SELECT * FROM accounts WHERE id = ?')
            .bind(accountId)
            .first<any>()
    )!;
    const session = await CreateSession(env.DJIBB_AUTH, {
        accounts: [
            {
                ...account,
                email_verified: true,
                flags: null,
                time_created: new Date(account.time_created * 1000),
                time_deleted: null,
                time_updated: new Date(account.time_updated * 1000),
            },
        ],
        ip_country: 'US',
    });
    return { sessionId: session.id, accountId };
}

describe('resolvePrincipal — which arm', () => {
    it('resolves a valid cookie to the session arm', async () => {
        const { sessionId, accountId } = await makeSession();
        const { principal } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId,
            bearerToken: null,
        });
        expect(principal.kind).toBe('session');
        if (principal.kind !== 'session') throw new Error('unreachable');
        expect(principal.sessionId).toBe(sessionId);
        expect(principal.accounts.map(a => a.id)).toContain(accountId);
    });

    it('resolves an absent cookie + valid bearer to the credential arm', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            boundEntityId: 'l/bound',
        });
        const { principal } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId: null,
            bearerToken: token,
        });
        expect(principal.kind).toBe('credential');
        if (principal.kind !== 'credential') throw new Error('unreachable');
        expect(principal.credentialId).toBe(credentialId);
        expect(principal.boundEntityId).toBe('l/bound');
        expect(principal.accounts.map(a => a.id)).toEqual([accountId]);
    });

    it('lets a valid cookie WIN over a bearer header (never consults it)', async () => {
        const { sessionId } = await makeSession();
        const other = await insertAccount();
        const { token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId: other,
        });
        const { principal } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId,
            bearerToken: token,
        });
        expect(principal.kind).toBe('session');
    });

    it('short-circuits a present-but-invalid cookie to anonymous — NOT bearer', async () => {
        const accountId = await insertAccount();
        const { token } = await CreateCredential(env.DJIBB_AUTH, { accountId });
        // A bogus session id that won't validate, plus a valid bearer.
        const { principal, cookie } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId: newId('session'),
            bearerToken: token,
        });
        expect(principal.kind).toBe('anonymous');
        expect(cookie).toBe('clear');
    });

    it('treats a blank ("") cookie as absent and tries the bearer', async () => {
        const accountId = await insertAccount();
        const { token } = await CreateCredential(env.DJIBB_AUTH, { accountId });
        const { principal } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId: '',
            bearerToken: token,
        });
        expect(principal.kind).toBe('credential');
    });

    it('is anonymous with neither a cookie nor a bearer', async () => {
        const { principal, cookie } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId: null,
            bearerToken: null,
        });
        expect(principal.kind).toBe('anonymous');
        expect(cookie).toBe('none');
    });
});

describe('resolvePrincipal — cookie directive', () => {
    it('asks to refresh a mid-life session cookie', async () => {
        const { sessionId } = await makeSession();
        // Push the session into its refresh window (second half of life).
        await env.DJIBB_AUTH.prepare(
            'UPDATE sessions SET time_expires = ? WHERE id = ?',
        )
            .bind(Math.floor(Date.now() / 1000) + 60, sessionId)
            .run();

        const { principal, cookie } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId,
            bearerToken: null,
        });
        expect(principal.kind).toBe('session');
        expect(cookie).toBe('refresh');
    });

    it('asks for no cookie change on a freshly-minted session', async () => {
        const { sessionId } = await makeSession();
        const { cookie } = await resolvePrincipal(env.DJIBB_AUTH, {
            sessionId,
            bearerToken: null,
        });
        expect(cookie).toBe('none');
    });
});
