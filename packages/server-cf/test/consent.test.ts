/**
 * Connect-ceremony disclosure interstitial tests (ADR 0024 §3; GH #29).
 *
 * The §3 claims, at the substrate + HTTP-seam level:
 *
 *   1. Pending connections are single-use and short-TTL — a fresh handle
 *      reads (idempotently) and then answers exactly once; replay and expiry
 *      resolve to nothing.
 *   2. `GET /auth/connect/consent` discloses the connection being made — the
 *      client's label + origin — and greets the identity ("Welcome, <name>!")
 *      without consuming the handle. There is no decline button (v1).
 *   3. The affirmative `POST` mints the #28 authorization code (which then
 *      exchanges to a working credential) and redirects to the client; a
 *      handle-less POST mints nothing.
 *   4. The handle is single-use: a replayed POST produces no second code.
 *   5. Only the SHA-256 of the handle is persisted; the raw handle never is.
 */

import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
    ConsumePendingConnection,
    GetPendingConnection,
    InsertPendingConnection,
} from '../src/auth/connect';
import { VerifyBearerCredential } from '../src/auth/d1';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

// RFC 7636 Appendix B S256 vector (shared with connect.test.ts).
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ALLOWED_ORIGIN = 'http://localhost:5173';

async function insertAccount(displayName = 'Ada Lovelace'): Promise<string> {
    const id = newId('account');
    const now = Math.floor(Date.now() / 1000);
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, flags, image,
            provider_name, provider_client_id, time_created, time_updated,
            user_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id,
            displayName,
            `t-${Math.random().toString(36).slice(2)}@example.com`,
            1,
            null,
            null,
            'google',
            'g-' + Math.random().toString(36).slice(2),
            now,
            now,
            null,
        )
        .run();
    return id;
}

async function openPending(
    accountId: string,
    opts: Partial<{
        displayName: string | null;
        label: string | null;
        now: number;
    }> = {},
): Promise<string> {
    const { handle } = await InsertPendingConnection(env.DJIBB_AUTH, {
        accountId,
        accountDisplayName:
            opts.displayName === undefined ? 'Ada Lovelace' : opts.displayName,
        clientOrigin: ALLOWED_ORIGIN,
        codeChallenge: RFC_CHALLENGE,
        label: opts.label ?? 'Secret Santa',
        now: opts.now,
    });
    return handle;
}

async function getConsent(handle: string): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
        new Request(
            `http://localhost:8787/auth/connect/consent?pending=${encodeURIComponent(handle)}`,
        ),
        env,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
}

async function postConsent(
    fields: Record<string, string>,
): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
        new Request('http://localhost:8787/auth/connect/consent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            redirect: 'manual',
        }),
        env,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
}

// ─── Pending substrate ────────────────────────────────────────────────────────

describe('pending-connection substrate', () => {
    it('reads idempotently, then consumes exactly once', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);
        const now = Math.floor(Date.now() / 1000);

        // Non-consuming read is repeatable.
        expect((await GetPendingConnection(env.DJIBB_AUTH, handle, now))!.account_id).toBe(
            accountId,
        );
        expect(await GetPendingConnection(env.DJIBB_AUTH, handle, now)).not.toBeNull();

        // First consume wins; second (replay) is null.
        expect((await ConsumePendingConnection(env.DJIBB_AUTH, handle, now))!.account_id).toBe(
            accountId,
        );
        expect(await ConsumePendingConnection(env.DJIBB_AUTH, handle, now)).toBeNull();
        // And it no longer reads as live.
        expect(await GetPendingConnection(env.DJIBB_AUTH, handle, now)).toBeNull();
    });

    it('an expired handle neither reads nor consumes', async () => {
        const accountId = await insertAccount();
        const past = Math.floor(Date.now() / 1000) - 60 * 60;
        const handle = await openPending(accountId, { now: past });
        const now = Math.floor(Date.now() / 1000);
        expect(await GetPendingConnection(env.DJIBB_AUTH, handle, now)).toBeNull();
        expect(await ConsumePendingConnection(env.DJIBB_AUTH, handle, now)).toBeNull();
    });

    it('persists only the SHA-256 of the handle, never the raw', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);
        const row = await env.DJIBB_AUTH.prepare(
            'SELECT * FROM connect_pending LIMIT 1',
        ).first<Record<string, unknown>>();
        expect(Object.values(row!)).not.toContain(handle);
    });
});

// ─── GET consent (disclosure) ──────────────────────────────────────────────────

describe('GET /auth/connect/consent', () => {
    it('discloses the client + origin and greets the identity by name', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, {
            displayName: 'Ada Lovelace',
            label: 'Secret Santa',
        });
        const res = await getConsent(handle);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('Secret Santa'); // the connecting client
        expect(html).toContain('Welcome, Ada Lovelace!'); // greeting
        expect(html).toContain(ALLOWED_ORIGIN); // requested-by disclosure
        expect(html).toContain('>Connect<'); // the single affirmative action
        expect(html).not.toContain('Not now'); // no decline button (v1)
        // Idempotent: the disclosure GET must not spend the handle.
        expect(
            await GetPendingConnection(
                env.DJIBB_AUTH,
                handle,
                Math.floor(Date.now() / 1000),
            ),
        ).not.toBeNull();
    });

    it('greets generically when the identity has no display name', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, { displayName: null });
        const html = await (await getConsent(handle)).text();
        expect(html).toContain('Welcome!');
    });

    it('escapes a hostile client label (no HTML injection)', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, {
            label: '<script>alert(1)</script>',
        });
        const html = await (await getConsent(handle)).text();
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('shows a terminal error for a missing/expired handle', async () => {
        expect((await getConsent('')).status).toBe(400);
        expect((await getConsent('never-existed-handle')).status).toBe(410);
    });

    it('refuses to disclose a pending bound to a now-unauthorized origin', async () => {
        // Simulates the allowlist being tightened after the ceremony started:
        // the row is live, but its origin is no longer trusted. The disclosure
        // must not present it as a legitimate request (defense in depth,
        // mirroring the POST handler).
        const accountId = await insertAccount();
        const { handle } = await InsertPendingConnection(env.DJIBB_AUTH, {
            accountId,
            accountDisplayName: 'Ada Lovelace',
            clientOrigin: 'https://evil.example.com',
            codeChallenge: RFC_CHALLENGE,
            label: 'Rogue Client',
        });
        const res = await getConsent(handle);
        expect(res.status).toBe(400);
        const html = await res.text();
        expect(html).not.toContain('Rogue Client');
        expect(html).not.toContain('evil.example.com');
    });
});

// ─── POST consent (the decision) ───────────────────────────────────────────────

describe('POST /auth/connect/consent', () => {
    it('the affirmative POST mints a code that exchanges to a working credential', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, { label: 'Secret Santa' });

        // Submitting the form IS the consent — the body carries only the
        // handle (there is no decision field / decline path in v1).
        const res = await postConsent({ handle });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location')!);
        expect(location.origin).toBe(ALLOWED_ORIGIN);
        expect(location.pathname).toBe('/accounts/verified');
        const code = location.searchParams.get('code');
        expect(code).toBeTruthy();
        expect(location.searchParams.has('error')).toBe(false);

        // The minted code exchanges for a credential that authenticates.
        const ctx = createExecutionContext();
        const tokenRes = await worker.fetch(
            new Request('http://localhost:8787/auth/connect/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, code_verifier: RFC_VERIFIER }),
            }),
            env,
            ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(tokenRes.status).toBe(200);
        const { access_token } = (await tokenRes.json()) as {
            access_token: string;
        };
        const resolved = await VerifyBearerCredential(
            env.DJIBB_AUTH,
            access_token,
        );
        expect(resolved!.account.id).toBe(accountId);

        // The credential carries the ceremony's client label (visible in the
        // connected-clients surface — §3 rule 3).
        const credRow = await env.DJIBB_AUTH.prepare(
            'SELECT label FROM issued_credentials WHERE account_id = ?',
        )
            .bind(accountId)
            .first<{ label: string | null }>();
        expect(credRow!.label).toBe('Secret Santa');
    });

    it('a POST with no handle mints nothing', async () => {
        const res = await postConsent({});
        expect(res.status).toBe(400);
        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_authorization_codes',
        ).first<{ n: number }>();
        expect(codes!.n).toBe(0);
    });

    it('a spent handle cannot be replayed (exactly one code, no double-mint)', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);

        // First submit consents and mints...
        expect((await postConsent({ handle })).status).toBe(302);
        // ...a replay finds nothing live and mints nothing more.
        const replay = await postConsent({ handle });
        expect(replay.status).toBe(410);
        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_authorization_codes',
        ).first<{ n: number }>();
        expect(codes!.n).toBe(1);
    });
});
