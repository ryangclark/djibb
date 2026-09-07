/**
 * Connect ceremony — the back half (ADR 0024 §1, §4; GH #28).
 *
 * The interactive ceremonies (OAuth, magic-link) already run on the auth
 * worker and, on success, know *which Account* just proved control. This
 * module is what lets that ceremony terminate by handing an **off-domain**
 * client a credential instead of the `djibb-session` cookie it can't use
 * cross-site:
 *
 *   1. On ceremony success (`auth/oauth.ts`, `auth/magic.ts`), the worker
 *      mints a single-use, short-TTL **authorization code** bound to the
 *      Account, the client's allowlisted origin, its PKCE challenge, and
 *      its label — {@link InsertAuthorizationCode} — and redirects back to
 *      `<origin>/accounts/verified?code=<raw>` *instead of* setting the
 *      session cookie for that flow.
 *   2. The client exchanges `code` + PKCE `code_verifier` at the token
 *      endpoint ({@link handleConnectToken}). We claim the code once
 *      ({@link ConsumeAuthorizationCode}), verify PKCE
 *      ({@link pkceS256Matches}), and mint an ordinary ADR 0022
 *      `issued_credentials` row via `CreateCredential` — returning the raw
 *      bearer token exactly once.
 *
 * The output is an ordinary credential: verified at the one request→Account
 * seam (`auth/principal.ts`), acting at the Account's resolved role per
 * entity (ADR 0021). **No new credential type, no new authorization model**
 * — the ceremony is only a new way for an `issued_credentials` row to come
 * into being.
 *
 * Public clients only (ADR 0024 §4): PKCE is mandatory (`S256`), codes are
 * single-use with a short TTL, and there are no client secrets. The raw
 * code lives only in the redirect URL; only its SHA-256 is persisted
 * (same posture as magic tokens and credential secrets — high-entropy, so
 * unsalted SHA-256 has no dictionary/rainbow surface).
 */

import type { Context } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '..';
import { BadRequestError } from '@djibb/protocol/errors';
import { randomString } from '@djibb/protocol/id';
import { runD1 } from '../effect/d1';
import { CreateCredential, hashSecret } from './d1';
import { parseAuthorizedDomains } from '../utils/origin';
import { base64UrlSha256 } from '../utils/base64url';

// ─── Tunables ───────────────────────────────────────────────────────────────

/**
 * Length of the random authorization code (url-safe chars). 43 chars over
 * the 64-char alphabet ≈ 258 bits — the same high-entropy threshold that
 * makes unsalted SHA-256 storage safe, matching the bearer-secret length.
 */
const CODE_LENGTH = 43;

/**
 * Authorization-code lifetime. The redirect→exchange hop is immediate; a
 * 5-minute ceiling is ample slack while keeping the replay window small.
 * Single-use (`time_consumed`) is the primary defense; this bounds a code
 * that is issued but never exchanged.
 */
const CODE_TTL_SECONDS = 5 * 60;

/**
 * Lifetime of the credential the ceremony mints. Non-NULL by policy
 * (ADR 0024 §6): connect-ceremony tokens are browser-holdable, so a bounded
 * blast radius on theft is the recommended default. Re-running the ceremony
 * is the refresh (ADR 0024 §Out-of-scope). Revocation is always available.
 */
const CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;

// ─── Ceremony context ───────────────────────────────────────────────────────

/**
 * What the front half captures at ceremony start and the terminal handler
 * needs to mint a code: the allowlisted client origin to redirect back to,
 * the PKCE challenge to bind, and the label to stamp on the credential.
 * OAuth carries this in the {@link CookieNames.Connect} cookie; magic-link
 * carries it on the token row (it can span two devices).
 */
export type ConnectCeremonyContext = {
    origin: string;
    codeChallenge: string;
    label: string | null;
};

/**
 * Exact-origin membership in the `AUTHORIZED_DOMAINS` allowlist — the v1
 * registration stance (ADR 0024 §5): ceremony origins are first-party,
 * operator-registered, and matched exactly (no path/subdomain wildcards).
 * The single guard both ceremony start and code redirect check.
 */
export function originIsAllowlisted(
    authorizedDomains: string | undefined,
    origin: string | null | undefined,
): boolean {
    if (!origin) return false;
    // Same parse as the CSRF host-matcher (`utils/origin.ts`) so both
    // allowlist checks normalize `AUTHORIZED_DOMAINS` identically — trimmed,
    // empties dropped — and can't disagree on a whitespace-padded entry.
    return parseAuthorizedDomains(authorizedDomains).includes(origin);
}

// ─── PKCE ─────────────────────────────────────────────────────────────────

/**
 * Constant-time string compare. Guards the PKCE challenge comparison
 * against timing oracles (both operands are fixed-length base64url).
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

/**
 * Does `verifier` satisfy the stored `S256` `challenge`? Only `S256` is
 * accepted — `plain` (challenge === verifier) is deliberately unsupported
 * (ADR 0024 §4). A missing/empty verifier can never match a real challenge.
 */
export async function pkceS256Matches(
    verifier: string,
    challenge: string,
): Promise<boolean> {
    if (!verifier || !challenge) return false;
    const computed = await base64UrlSha256(verifier);
    return timingSafeEqual(computed, challenge);
}

// ─── Authorization-code substrate ───────────────────────────────────────────

/**
 * The row an exchange resolves to. `code_challenge` stays internal to the
 * verify step; the fields the token endpoint needs to mint a credential are
 * the Account, the client label, and the (reserved) entity binding.
 */
export type ConsumedAuthorizationCode = {
    account_id: string;
    client_origin: string;
    code_challenge: string;
    label: string | null;
    bound_entity_id: string | null;
};

/**
 * Mint an authorization code for a completed ceremony. Returns the **raw**
 * code (lives only in the redirect URL); only its SHA-256 is persisted, so
 * a DB read cannot replay a live code.
 */
export async function InsertAuthorizationCode(
    d1: D1Database,
    args: {
        accountId: string;
        clientOrigin: string;
        codeChallenge: string;
        label?: string | null;
        boundEntityId?: string | null;
        /** Override "now" (unix seconds) for deterministic tests. */
        now?: number;
    },
): Promise<{ code: string }> {
    const rawCode = randomString(CODE_LENGTH);
    const codeHash = await hashSecret(rawCode);
    const now = args.now ?? Math.floor(Date.now() / 1000);

    await runD1(
        d1,
        'InsertAuthorizationCode',
        sql =>
            sql`INSERT INTO connect_authorization_codes (
                    code_hash,
                    account_id,
                    client_origin,
                    code_challenge,
                    label,
                    bound_entity_id,
                    time_created,
                    time_expires
                ) VALUES (${codeHash}, ${args.accountId}, ${args.clientOrigin},
                    ${args.codeChallenge}, ${args.label ?? null},
                    ${args.boundEntityId ?? null}, ${now},
                    ${now + CODE_TTL_SECONDS})`,
    );

    return { code: rawCode };
}

/**
 * Atomically claim an authorization code by its SHA-256 hash. Single
 * UPDATE...RETURNING, mirroring `consumeMagicTokenRow`: if zero rows match,
 * the code is unknown, already consumed (replay), or expired — the caller
 * treats all three as the same `invalid_grant` (distinguishing them would
 * help an attacker triangulate code state). Returns the row's ceremony
 * context on success, or `null`.
 */
export async function ConsumeAuthorizationCode(
    d1: D1Database,
    rawCode: string,
    now: number,
): Promise<ConsumedAuthorizationCode | null> {
    const codeHash = await hashSecret(rawCode);
    const rows = await runD1(
        d1,
        'ConsumeAuthorizationCode',
        sql =>
            sql<ConsumedAuthorizationCode>`UPDATE connect_authorization_codes
                SET time_consumed = ${now}
                WHERE code_hash = ${codeHash}
                    AND time_consumed IS NULL
                    AND time_expires > ${now}
                RETURNING account_id, client_origin, code_challenge, label,
                    bound_entity_id`,
    );
    return rows[0] ?? null;
}

// ─── Token endpoint ─────────────────────────────────────────────────────────

const TokenBodySchema = z.object({
    code: z.string().min(8).max(128),
    code_verifier: z.string().min(43).max(128),
});

/**
 * POST /auth/connect/token
 *
 * Body: { code, code_verifier }
 *
 * Exchanges a ceremony authorization code + PKCE verifier for a bearer
 * credential. On success mints an `issued_credentials` row (Account and
 * label from the code) and returns the raw token **once**. Every failure
 * (unknown/expired/replayed code, PKCE mismatch) is a flat 400
 * `invalid_grant` — the raw token is never logged.
 *
 * CSRF: this route is exempt from the Origin allowlist check (see
 * `src/index.ts`), exactly like `/auth/magic/consume`. Its authenticity is
 * the body-carried code + verifier — a secret only the client that started
 * the ceremony holds — not a cookie or a same-origin POST.
 */
export async function handleConnectToken(c: Context<HonoEnv>) {
    const body = await c.req.json().catch(() => null);
    const parsed = TokenBodySchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError('invalid request');
    }

    const now = Math.floor(Date.now() / 1000);

    const claimed = await ConsumeAuthorizationCode(
        c.env.DJIBB_AUTH,
        parsed.data.code,
        now,
    );
    if (!claimed) {
        return c.json({ error: 'invalid_grant' }, 400);
    }

    const pkceOk = await pkceS256Matches(
        parsed.data.code_verifier,
        claimed.code_challenge,
    );
    if (!pkceOk) {
        // The code is already consumed above (single-use is spent even on a
        // bad verifier — a failed exchange must not leave a replayable code).
        return c.json({ error: 'invalid_grant' }, 400);
    }

    let minted;
    try {
        minted = await CreateCredential(c.env.DJIBB_AUTH, {
            accountId: claimed.account_id,
            label: claimed.label,
            boundEntityId: claimed.bound_entity_id,
            timeExpires: now + CREDENTIAL_TTL_SECONDS,
            now,
        });
    } catch (err) {
        // Never include the (never-yet-produced) token in the log line.
        console.error('`handleConnectToken()` mint error:', err);
        return c.json({ error: 'server_error' }, 500);
    }

    c.header('Cache-Control', 'no-store');
    return c.json({
        access_token: minted.token,
        token_type: 'Bearer',
        account_id: claimed.account_id,
        credential_id: minted.credentialId,
    });
}
