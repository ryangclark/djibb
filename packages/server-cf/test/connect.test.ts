/**
 * Connect-ceremony back-half tests (ADR 0024 §1, §4; GH #28).
 *
 * The load-bearing security claims of the ceremony's token half, at the
 * substrate + HTTP-seam level (mirrors `credential.test.ts`):
 *
 *   1. PKCE S256 — the right verifier matches the stored challenge; a wrong
 *      verifier, a `plain` verifier, or an empty one never does.
 *   2. Authorization codes are single-use and short-TTL — a fresh code
 *      exchanges once; replay and expired-code exchanges resolve to nothing.
 *   3. The full exchange mints an ordinary ADR 0022 credential carrying the
 *      client's label, and that credential authenticates (resolves via
 *      `VerifyBearerCredential` — the request→Account seam).
 *   4. Only the SHA-256 of the code is persisted; the raw code never is.
 *   5. Magic-link threads its connect context on the *token row* (survives
 *      the cross-device email hop); a `signin` token carries none.
 *   6. The `POST /auth/connect/token` endpoint end-to-end: an authorized
 *      code + verifier yields a bearer token that authenticates a request,
 *      and it sets no `djibb-session` cookie (the two terminal forms stay
 *      cleanly separate — ADR 0024 §Negative).
 */

import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
    ConsumeAuthorizationCode,
    InsertAuthorizationCode,
    originIsAllowlisted,
    pkceS256Matches,
} from '../src/auth/connect';
import {
    CreateCredential,
    InsertMagicLinkToken,
    VerifyBearerCredential,
    consumeMagicTokenRow,
    hashSecret,
} from '../src/auth/d1';
import { hashToken } from '../src/auth/magic';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

// RFC 7636 Appendix B S256 test vector — pins our transform to the spec.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

// The one origin the test env allowlists (vitest.config.ts miniflare bindings).
const ALLOWED_ORIGIN = 'http://localhost:5173';

async function insertAccount(email?: string): Promise<string> {
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
            'Test User',
            email ?? `t-${Math.random().toString(36).slice(2)}@example.com`,
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

// ─── PKCE ─────────────────────────────────────────────────────────────────

describe('pkceS256Matches', () => {
    it('accepts the RFC 7636 S256 vector', async () => {
        expect(await pkceS256Matches(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    });

    it('rejects a wrong verifier', async () => {
        expect(await pkceS256Matches('not-the-verifier', RFC_CHALLENGE)).toBe(
            false,
        );
    });

    it('rejects a `plain` verifier (challenge presented as its own verifier)', async () => {
        // Only S256 is supported — a client that skipped the SHA-256 and
        // sent the challenge value as the verifier must be rejected.
        expect(await pkceS256Matches(RFC_CHALLENGE, RFC_CHALLENGE)).toBe(false);
    });

    it('rejects an empty verifier', async () => {
        expect(await pkceS256Matches('', RFC_CHALLENGE)).toBe(false);
    });
});

// ─── Origin allowlist ───────────────────────────────────────────────────────

describe('originIsAllowlisted', () => {
    it('accepts an exact allowlisted origin', () => {
        expect(originIsAllowlisted('a.com;b.com', 'b.com')).toBe(true);
    });
    it('rejects a non-member origin, empty allowlist, and nullish origin', () => {
        expect(originIsAllowlisted('a.com;b.com', 'evil.com')).toBe(false);
        expect(originIsAllowlisted('', 'a.com')).toBe(false);
        expect(originIsAllowlisted(undefined, 'a.com')).toBe(false);
        expect(originIsAllowlisted('a.com', null)).toBe(false);
    });
});

// ─── Authorization-code lifecycle ─────────────────────────────────────────────

describe('authorization code — single-use + TTL', () => {
    it('round-trips the ceremony context on first consume', async () => {
        const accountId = await insertAccount();
        const now = 1_000_000;
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
            label: 'Secret Santa',
            now,
        });

        const claimed = await ConsumeAuthorizationCode(
            env.DJIBB_AUTH,
            code,
            now + 1,
        );
        expect(claimed).toEqual({
            account_id: accountId,
            client_origin: ALLOWED_ORIGIN,
            code_challenge: RFC_CHALLENGE,
            label: 'Secret Santa',
            bound_entity_id: null,
        });
    });

    it('rejects a replayed code (second consume is null)', async () => {
        const accountId = await insertAccount();
        const now = 1_000_000;
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
            now,
        });

        expect(
            await ConsumeAuthorizationCode(env.DJIBB_AUTH, code, now + 1),
        ).not.toBeNull();
        expect(
            await ConsumeAuthorizationCode(env.DJIBB_AUTH, code, now + 2),
        ).toBeNull();
    });

    it('rejects an expired code', async () => {
        const accountId = await insertAccount();
        const now = 1_000_000;
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
            now,
        });
        // TTL is 5 minutes; consume 301s later.
        expect(
            await ConsumeAuthorizationCode(
                env.DJIBB_AUTH,
                code,
                now + 5 * 60 + 1,
            ),
        ).toBeNull();
    });

    it('rejects an unknown code', async () => {
        expect(
            await ConsumeAuthorizationCode(
                env.DJIBB_AUTH,
                'c/nonexistent-code',
                1_000_000,
            ),
        ).toBeNull();
    });

    it('persists only the SHA-256 of the code, never the raw', async () => {
        const accountId = await insertAccount();
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
        });
        const row = await env.DJIBB_AUTH.prepare(
            'SELECT * FROM connect_authorization_codes LIMIT 1',
        ).first<Record<string, any>>();
        expect(row!.code_hash).toBe(await hashSecret(code));
        // No column holds the raw code.
        expect(Object.values(row!)).not.toContain(code);
    });
});

// ─── Full exchange → credential ───────────────────────────────────────────────

describe('exchange mints an authenticating credential', () => {
    it('consume + PKCE + mint → the credential resolves the ceremony Account and carries the label', async () => {
        const accountId = await insertAccount();
        const now = 2_000_000;
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
            label: 'Weird Client',
            now,
        });

        const claimed = await ConsumeAuthorizationCode(
            env.DJIBB_AUTH,
            code,
            now + 1,
        );
        expect(claimed).not.toBeNull();
        expect(await pkceS256Matches(RFC_VERIFIER, claimed!.code_challenge)).toBe(
            true,
        );

        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId: claimed!.account_id,
            label: claimed!.label,
            timeExpires: now + 90 * 24 * 60 * 60,
            now,
        });

        const resolved = await VerifyBearerCredential(env.DJIBB_AUTH, token, {
            now: now + 2,
        });
        expect(resolved!.account.id).toBe(accountId);
        expect(resolved!.credential_id).toBe(credentialId);

        const credRow = await env.DJIBB_AUTH.prepare(
            'SELECT label FROM issued_credentials WHERE credential_id = ?',
        )
            .bind(credentialId)
            .first<{ label: string | null }>();
        expect(credRow!.label).toBe('Weird Client');
    });
});

// ─── Magic-link connect threading (token-bound, cross-device) ──────────────────

describe('magic-link connect context rides on the token row', () => {
    it('consumeMagicTokenRow returns the connect_* columns for a connect token', async () => {
        const rawToken = 'raw-connect-token-value';
        const tokenHash = await hashToken(rawToken);
        const now = Math.floor(Date.now() / 1000);
        await InsertMagicLinkToken(env.DJIBB_AUTH, {
            tokenHash,
            targetEmail: 'user@example.com',
            purpose: 'connect',
            timeCreated: now,
            timeExpires: now + 900,
            requestIp: null,
            userAgent: null,
            connectOrigin: ALLOWED_ORIGIN,
            connectCodeChallenge: RFC_CHALLENGE,
            connectLabel: 'Secret Santa',
        });

        const row = await consumeMagicTokenRow(env.DJIBB_AUTH, tokenHash, now);
        expect(row).toMatchObject({
            purpose: 'connect',
            connect_origin: ALLOWED_ORIGIN,
            connect_code_challenge: RFC_CHALLENGE,
            connect_label: 'Secret Santa',
        });
    });

    it('a plain signin token carries no connect context', async () => {
        const rawToken = 'raw-signin-token-value';
        const tokenHash = await hashToken(rawToken);
        const now = Math.floor(Date.now() / 1000);
        await InsertMagicLinkToken(env.DJIBB_AUTH, {
            tokenHash,
            targetEmail: 'user@example.com',
            purpose: 'signin',
            timeCreated: now,
            timeExpires: now + 900,
            requestIp: null,
            userAgent: null,
        });

        const row = await consumeMagicTokenRow(env.DJIBB_AUTH, tokenHash, now);
        expect(row).toMatchObject({
            purpose: 'signin',
            connect_origin: null,
            connect_code_challenge: null,
            connect_label: null,
        });
    });
});

// ─── POST /auth/connect/token (end-to-end) ─────────────────────────────────────

async function postToken(body: unknown): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
        new Request('http://localhost:8787/auth/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        env,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
}

describe('POST /auth/connect/token', () => {
    it('exchanges a valid code + verifier for a bearer token that authenticates', async () => {
        const accountId = await insertAccount();
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
            label: 'End To End',
        });

        const res = await postToken({ code, code_verifier: RFC_VERIFIER });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            access_token: string;
            account_id: string;
            credential_id: string;
        };
        expect(json.account_id).toBe(accountId);

        // The minted token authenticates at the request→Account seam.
        const resolved = await VerifyBearerCredential(
            env.DJIBB_AUTH,
            json.access_token,
        );
        expect(resolved!.account.id).toBe(accountId);

        // Never a session cookie — the two terminal forms stay separate.
        expect(res.headers.get('set-cookie') ?? '').not.toContain(
            'djibb-session',
        );
    });

    it('rejects an exchange with the wrong PKCE verifier', async () => {
        const accountId = await insertAccount();
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
        });
        const res = await postToken({
            code,
            code_verifier: 'wrong-verifier-that-is-long-enough-to-pass-schema',
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_grant' });
    });

    it('rejects a replayed code (second exchange fails)', async () => {
        const accountId = await insertAccount();
        const { code } = await InsertAuthorizationCode(env.DJIBB_AUTH, {
            accountId,
            clientOrigin: ALLOWED_ORIGIN,
            codeChallenge: RFC_CHALLENGE,
        });
        expect(
            (await postToken({ code, code_verifier: RFC_VERIFIER })).status,
        ).toBe(200);
        const replay = await postToken({ code, code_verifier: RFC_VERIFIER });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_grant' });
    });

    it('rejects an unknown code', async () => {
        const res = await postToken({
            code: 'c/definitely-not-a-real-code',
            code_verifier: RFC_VERIFIER,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_grant' });
    });
});
