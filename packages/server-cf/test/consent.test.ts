/**
 * Connect-ceremony disclosure interstitial tests (ADR 0024 §3; GH #29).
 *
 * The §3 claims, at the substrate + HTTP-seam level:
 *
 *   1. Pending connections are single-use and short-TTL — a fresh handle
 *      reads (idempotently) and then answers exactly once; replay, decline,
 *      and expiry all resolve to nothing.
 *   2. `GET /auth/connect/consent` discloses the connection being made — the
 *      client's label + origin — and recognizes a returning identity
 *      ("welcome back") without consuming the handle.
 *   3. `POST` approve mints the #28 authorization code (which then exchanges
 *      to a working credential) and redirects to the client; decline mints
 *      NO code and redirects with `?error=access_denied`.
 *   4. The two states are exclusive: after a decline the handle is dead, so
 *      no code can be produced from it afterward.
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
        preexisting: boolean;
        label: string | null;
        now: number;
    }> = {},
): Promise<string> {
    const { handle } = await InsertPendingConnection(env.DJIBB_AUTH, {
        accountId,
        accountDisplayName: opts.displayName ?? 'Ada Lovelace',
        accountPreexisting: opts.preexisting ?? true,
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
    it('discloses the client and recognizes a returning identity', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, {
            preexisting: true,
            displayName: 'Ada Lovelace',
            label: 'Secret Santa',
        });
        const res = await getConsent(handle);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('Secret Santa'); // the connecting client
        expect(html).toContain('Welcome back'); // returning-identity copy
        expect(html).toContain('Ada Lovelace'); // the recognized identity
        expect(html).toContain(ALLOWED_ORIGIN); // requested-by disclosure
        // Idempotent: the disclosure GET must not spend the handle.
        expect(
            await GetPendingConnection(
                env.DJIBB_AUTH,
                handle,
                Math.floor(Date.now() / 1000),
            ),
        ).not.toBeNull();
    });

    it('does not say "welcome back" for a brand-new identity', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, { preexisting: false });
        const html = await (await getConsent(handle)).text();
        expect(html).not.toContain('Welcome back');
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
});

// ─── POST consent (the decision) ───────────────────────────────────────────────

describe('POST /auth/connect/consent', () => {
    it('approve mints a code that exchanges to a working credential', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId, { label: 'Secret Santa' });

        const res = await postConsent({ handle, decision: 'approve' });
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

    it('decline mints no code and redirects with access_denied', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);

        const res = await postConsent({ handle, decision: 'decline' });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location')!);
        expect(location.origin).toBe(ALLOWED_ORIGIN);
        expect(location.searchParams.get('error')).toBe('access_denied');
        expect(location.searchParams.has('code')).toBe(false);

        // No authorization code was ever minted.
        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_authorization_codes',
        ).first<{ n: number }>();
        expect(codes!.n).toBe(0);
    });

    it('treats an unknown decision value as a decline (never mints)', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);
        const res = await postConsent({ handle, decision: 'yes-please-hack' });
        const location = new URL(res.headers.get('location')!);
        expect(location.searchParams.get('error')).toBe('access_denied');
        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_authorization_codes',
        ).first<{ n: number }>();
        expect(codes!.n).toBe(0);
    });

    it('a spent handle cannot be approved afterward (decline is terminal)', async () => {
        const accountId = await insertAccount();
        const handle = await openPending(accountId);

        // Decline spends the handle...
        await postConsent({ handle, decision: 'decline' });
        // ...so a follow-up approve finds nothing live.
        const res = await postConsent({ handle, decision: 'approve' });
        expect(res.status).toBe(410);
        const codes = await env.DJIBB_AUTH.prepare(
            'SELECT COUNT(*) AS n FROM connect_authorization_codes',
        ).first<{ n: number }>();
        expect(codes!.n).toBe(0);
    });
});
