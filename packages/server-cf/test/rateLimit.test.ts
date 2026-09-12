/**
 * System-wide rate limiting (GH #14, #40, #70).
 *
 * Drives `worker.fetch` through the full CORS/CSRF + HandleSession pipeline
 * (like `accountDeletion.test.ts`) to prove the three Workers Rate Limiting
 * bindings actually gate:
 *
 *   1. Anonymous `/push` hits `RL_ANON_WRITE` (keyed by IP): the (limit+1)th
 *      write is a 429 with `Retry-After` + the shared body shape.
 *   2. `GET /websocket` — a DO-creation vector despite being a GET — is
 *      throttled too (the gate is by ROUTE, not HTTP method; GH #14).
 *   3. `POST /pull` (Replicache's read/sync path) is NOT throttled, even
 *      though it is a POST: reads stay unthrottled.
 *   4. Authenticated writes use the *looser* `RL_ACCT_WRITE` (keyed by
 *      account): well past the anon cap, still no 429 — proving the branch,
 *      not the shared window.
 *   5. The OAuth callback hits `RL_AUTH_IP` (keyed by IP): the (limit+1)th
 *      call is a 429 before any OAuth validation runs.
 *   6. The connect-ceremony token exchange (`POST /connect/token`) shares
 *      `RL_AUTH_IP` (keyed by IP): the (limit+1)th call is a 429 before the
 *      body parse / code consume (GH #70).
 *
 * The `@cloudflare/vitest-pool-workers` miniflare DOES simulate the
 * `[[ratelimits]]` bindings (in-memory per-key buckets), so these run
 * against the real helper end-to-end — no injectable seam needed.
 *
 * The buckets live in a pool-shared worker service (not isolated storage),
 * so they persist across tests within this run: every case uses a UNIQUE
 * key (IP or account) to stay independent. The caps below mirror
 * `wrangler.toml` — bump them here in lockstep if the config changes.
 */
import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import { CreateSession, GetAccountById } from '../src/auth/d1';
import { newId } from '@djibb/protocol/id';
import type { Account } from '@djibb/protocol/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const ORIGIN = 'http://localhost:5173';
const HOST = new URL(ORIGIN).host;

// Mirrors wrangler.toml's `[[ratelimits]]` `simple.limit` values.
const ANON_WRITE_LIMIT = 60;
const AUTH_IP_LIMIT = 20;

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

async function insertAccount(): Promise<string> {
    const id = newId('account');
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, flags, image,
            provider_name, provider_client_id, time_created, time_updated,
            time_deleted, user_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id,
            'RL Test User',
            `rl-${Math.random().toString(36).slice(2)}@example.com`,
            1,
            null,
            null,
            'google',
            'g-' + Math.random().toString(36).slice(2),
            1_700_000_000,
            1_700_000_000,
            null,
            null,
        )
        .run();
    return id;
}

/** A real session over one account; returns the `djibb-session` cookie. */
async function cookieForNewAccount(): Promise<string> {
    const accountId = await insertAccount();
    const account = (await GetAccountById(
        env.DJIBB_AUTH,
        accountId,
    )) as Account;
    const session = await CreateSession(env.DJIBB_AUTH, {
        accounts: [account],
        ip_country: '',
    });
    return `djibb-session=${session.id}`;
}

/**
 * POST an intentionally-empty push body. The write limiter runs right after
 * principal resolution — before the push handler parses the body — so the
 * request is *counted* regardless of the malformed body (which then 4xxs).
 * That keeps the loop cheap (no Durable Object is ever minted).
 */
async function anonWrite(entityId: string, ip: string): Promise<Response> {
    const req = new Request(
        `${ORIGIN}/list/push?id=${encodeURIComponent(entityId)}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: ORIGIN,
                Host: HOST,
                'CF-Connecting-IP': ip,
            },
            body: JSON.stringify({}),
        },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

async function authedWrite(
    entityId: string,
    cookie: string,
): Promise<Response> {
    const req = new Request(
        `${ORIGIN}/list/push?id=${encodeURIComponent(entityId)}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: ORIGIN,
                Host: HOST,
                Cookie: cookie,
            },
            body: JSON.stringify({}),
        },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

/**
 * GET the websocket upgrade route. It forwards to the DO stub
 * unconditionally (instantiating the DO even pre-init), so it IS a
 * DO-creation vector and must be throttled despite being a GET. No Upgrade
 * header is needed here: the limiter runs before the handler.
 */
async function websocketUpgrade(entityId: string, ip: string): Promise<Response> {
    const req = new Request(
        `${ORIGIN}/list/websocket?id=${encodeURIComponent(entityId)}`,
        {
            method: 'GET',
            headers: { 'CF-Connecting-IP': ip },
        },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

/**
 * POST /pull — Replicache's READ/sync path. It `throw`s NotFound on a
 * missing entity before touching the DO, so it must NOT be throttled even
 * though it is a POST.
 */
async function pull(entityId: string, ip: string): Promise<Response> {
    const req = new Request(
        `${ORIGIN}/list/pull?id=${encodeURIComponent(entityId)}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: ORIGIN,
                Host: HOST,
                'CF-Connecting-IP': ip,
            },
            body: JSON.stringify({}),
        },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

async function oauthCallback(ip: string): Promise<Response> {
    // No valid code/state — but the per-IP limiter is the very first thing
    // the handler does, so it fires before the validation throw.
    const req = new Request(`${ORIGIN}/auth/google/verify`, {
        method: 'GET',
        headers: { 'CF-Connecting-IP': ip },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

async function connectToken(ip: string): Promise<Response> {
    // No valid code/verifier — but the per-IP limiter runs before the body
    // parse, so it fires before the `invalid_grant`/400 the empty body would
    // otherwise produce. `/connect/token` is CSRF-exempt (body-authenticated),
    // so no Origin header is needed.
    const req = new Request(`${ORIGIN}/auth/connect/token`, {
        method: 'POST',
        headers: {
            'CF-Connecting-IP': ip,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

describe('anonymous entity writes → RL_ANON_WRITE (per IP)', () => {
    it('throttles the (limit+1)th write with a 429 + Retry-After', async () => {
        const entityId = newId('list');
        const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

        // The first `limit` writes are all admitted (not 429). Downstream
        // they 4xx on the empty body — what matters here is they pass the gate.
        for (let i = 0; i < ANON_WRITE_LIMIT; i++) {
            const res = await anonWrite(entityId, ip);
            expect(res.status).not.toBe(429);
        }

        const over = await anonWrite(entityId, ip);
        expect(over.status).toBe(429);
        expect(over.headers.get('Retry-After')).toBeTruthy();
        const body = (await over.json()) as {
            error: string;
            retry_after_seconds: number;
        };
        expect(body.error).toBe('rate_limited');
        expect(body.retry_after_seconds).toBeGreaterThan(0);
    });
});

describe('websocket upgrades → RL_ANON_WRITE (DO-creation vector, GH #14)', () => {
    it('throttles the (limit+1)th GET /websocket despite being a GET', async () => {
        const entityId = newId('list');
        const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

        for (let i = 0; i < ANON_WRITE_LIMIT; i++) {
            const res = await websocketUpgrade(entityId, ip);
            expect(res.status).not.toBe(429);
        }

        const over = await websocketUpgrade(entityId, ip);
        expect(over.status).toBe(429);
        expect(over.headers.get('Retry-After')).toBeTruthy();
    });
});

describe('reads (POST /pull) are NOT throttled by the write limiter', () => {
    it('admits well past the anon cap — a read-only viewer never 429s', async () => {
        const entityId = newId('list');
        const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

        // Past the anon write cap. /pull is a POST; a method-based gate
        // would 429 the 61st. It must not — reads stay unthrottled.
        for (let i = 0; i < ANON_WRITE_LIMIT + 5; i++) {
            const res = await pull(entityId, ip);
            expect(res.status).not.toBe(429);
        }
    });
});

describe('authenticated entity writes → RL_ACCT_WRITE (looser, per account)', () => {
    it('does not 429 well past the anonymous cap', async () => {
        const entityId = newId('list');
        const cookie = await cookieForNewAccount();

        // Same account, past the anonymous limit. If authed traffic were
        // (wrongly) sharing the anon window this would 429; it must not.
        for (let i = 0; i < ANON_WRITE_LIMIT + 5; i++) {
            const res = await authedWrite(entityId, cookie);
            expect(res.status).not.toBe(429);
        }
    });
});

describe('OAuth callback → RL_AUTH_IP (per IP)', () => {
    it('throttles the (limit+1)th callback with a 429', async () => {
        const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

        for (let i = 0; i < AUTH_IP_LIMIT; i++) {
            const res = await oauthCallback(ip);
            expect(res.status).not.toBe(429);
        }

        const over = await oauthCallback(ip);
        expect(over.status).toBe(429);
        expect(over.headers.get('Retry-After')).toBeTruthy();
    });
});

describe('connect-ceremony token exchange → RL_AUTH_IP (per IP, GH #70)', () => {
    it('throttles the (limit+1)th POST /connect/token with a 429', async () => {
        // Distinct subnet from the OAuth-callback test (198.51.100.0/24):
        // both share the RL_AUTH_IP bucket, which persists across tests in
        // this run, so a same-IP pick would spend this test's warm-up hits
        // on the OAuth test's tab and 429 early.
        const ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;

        // The first `limit` calls pass the gate (they 4xx downstream on the
        // empty body — `invalid_grant`/400 — but that is past the limiter).
        for (let i = 0; i < AUTH_IP_LIMIT; i++) {
            const res = await connectToken(ip);
            expect(res.status).not.toBe(429);
        }

        const over = await connectToken(ip);
        expect(over.status).toBe(429);
        expect(over.headers.get('Retry-After')).toBeTruthy();
        const body = (await over.json()) as {
            error: string;
            retry_after_seconds: number;
        };
        expect(body.error).toBe('rate_limited');
        expect(body.retry_after_seconds).toBeGreaterThan(0);
    });
});
