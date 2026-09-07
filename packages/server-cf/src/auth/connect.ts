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
import { escapeHtml } from '../utils/html';

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

/**
 * Lifetime of a pending connection — the window between a ceremony verifying
 * the user and the user approving (or declining) on the disclosure page
 * (ADR 0024 §3; GH #29). Longer than a code's TTL because a human has to
 * *read* the disclosure and click, not just round-trip a redirect. Still
 * single-use (`time_consumed`); this only bounds a consent that is opened
 * but never answered.
 */
const PENDING_TTL_SECONDS = 15 * 60;

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

// ─── Pending-connection substrate (disclosure interstitial, §3) ───────────────

/**
 * What a ceremony captures for the disclosure page and the later mint. The
 * `account*` fields are the recognition surface (§3 rule 1); the client
 * fields are threaded verbatim into {@link InsertAuthorizationCode} on
 * approval, so the exchanged code carries the same ceremony context #28 set.
 */
export type PendingConnectionInput = {
    accountId: string;
    accountDisplayName: string | null;
    /** Did the ceremony resolve an existing Account (→ "welcome back")? */
    accountPreexisting: boolean;
    clientOrigin: string;
    codeChallenge: string;
    label: string | null;
    boundEntityId?: string | null;
};

/** The pending row as the consent page reads it. */
export type PendingConnectionRow = {
    account_id: string;
    account_display_name: string | null;
    account_preexisting: number;
    client_origin: string;
    code_challenge: string;
    label: string | null;
    bound_entity_id: string | null;
};

/**
 * Open a pending connection for a just-verified ceremony. Returns the **raw**
 * handle (lives only in the consent-page URL); only its SHA-256 is stored, so
 * a DB read cannot forge a live consent.
 */
export async function InsertPendingConnection(
    d1: D1Database,
    input: PendingConnectionInput & { now?: number },
): Promise<{ handle: string }> {
    const rawHandle = randomString(CODE_LENGTH);
    const handleHash = await hashSecret(rawHandle);
    const now = input.now ?? Math.floor(Date.now() / 1000);

    await runD1(
        d1,
        'InsertPendingConnection',
        sql =>
            sql`INSERT INTO connect_pending (
                    handle_hash,
                    account_id,
                    account_display_name,
                    account_preexisting,
                    client_origin,
                    code_challenge,
                    label,
                    bound_entity_id,
                    time_created,
                    time_expires
                ) VALUES (${handleHash}, ${input.accountId},
                    ${input.accountDisplayName ?? null},
                    ${input.accountPreexisting ? 1 : 0}, ${input.clientOrigin},
                    ${input.codeChallenge}, ${input.label ?? null},
                    ${input.boundEntityId ?? null}, ${now},
                    ${now + PENDING_TTL_SECONDS})`,
    );

    return { handle: rawHandle };
}

/**
 * Read a live pending connection **without consuming it** — the consent GET
 * renders from this, and rendering must be idempotent (a reload, a
 * mail-scanner prefetch, a back button must not spend the handle). Returns
 * null if unknown, already answered, or expired.
 */
export async function GetPendingConnection(
    d1: D1Database,
    rawHandle: string,
    now: number,
): Promise<PendingConnectionRow | null> {
    const handleHash = await hashSecret(rawHandle);
    const rows = await runD1(
        d1,
        'GetPendingConnection',
        sql =>
            sql<PendingConnectionRow>`SELECT account_id, account_display_name,
                    account_preexisting, client_origin, code_challenge, label,
                    bound_entity_id
                FROM connect_pending
                WHERE handle_hash = ${handleHash}
                    AND time_consumed IS NULL
                    AND time_expires > ${now}`,
    );
    return rows[0] ?? null;
}

/**
 * Atomically claim a pending connection — spent by *either* approve or
 * decline, so a handle answers exactly once. Same single-UPDATE...RETURNING
 * shape as {@link ConsumeAuthorizationCode}; a null return (unknown, already
 * answered, expired) is the caller's "this consent is no longer live".
 */
export async function ConsumePendingConnection(
    d1: D1Database,
    rawHandle: string,
    now: number,
): Promise<PendingConnectionRow | null> {
    const handleHash = await hashSecret(rawHandle);
    const rows = await runD1(
        d1,
        'ConsumePendingConnection',
        sql =>
            sql<PendingConnectionRow>`UPDATE connect_pending
                SET time_consumed = ${now}
                WHERE handle_hash = ${handleHash}
                    AND time_consumed IS NULL
                    AND time_expires > ${now}
                RETURNING account_id, account_display_name, account_preexisting,
                    client_origin, code_challenge, label, bound_entity_id`,
    );
    return rows[0] ?? null;
}

// ─── Disclosure interstitial (the connection moment, §3) ──────────────────────

/** Client display name for the copy: its label, else its bare origin. */
function clientName(row: PendingConnectionRow): string {
    return row.label && row.label.trim() ? row.label : row.client_origin;
}

/**
 * The disclosure page (§3). Worker-owned, self-contained, no client script.
 * Names what is connecting to what, recognizes a returning identity, and
 * offers Approve / Decline — the two buttons POST the handle back to this
 * same route. It discloses only the connection being made: the client's
 * name/origin and (when returning) the identity's own display name — never
 * anything about the Account's other clients or entities (§3 rule 2).
 */
function renderConsentPage(handle: string, row: PendingConnectionRow): string {
    const client = escapeHtml(clientName(row));
    const origin = escapeHtml(row.client_origin);
    const preexisting = row.account_preexisting === 1;
    const name = row.account_display_name
        ? escapeHtml(row.account_display_name)
        : null;

    const heading = preexisting
        ? name
            ? `Welcome back, ${name}`
            : 'Welcome back'
        : 'Connect your djibb identity';
    const lead = preexisting
        ? `This connects <strong>${client}</strong> to your djibb identity.`
        : `This creates a djibb identity and connects <strong>${client}</strong> to it.`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect to djibb</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { max-width: 26rem; width: 100%; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  .origin { color: #666; font-size: .85rem; word-break: break-all; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .5rem;
           border: 1px solid #8884; cursor: pointer; flex: 1; }
  button.approve { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.decline { background: transparent; }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  <p>${lead}</p>
  <p class="origin">Requested by ${origin}</p>
  <form method="post" action="/auth/connect/consent">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <div class="actions">
      <button class="decline" type="submit" name="decision" value="decline">Not now</button>
      <button class="approve" type="submit" name="decision" value="approve">Connect</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

/** Terminal page shown when a consent handle is missing/expired/answered. */
function renderConsentError(message: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect to djibb</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { max-width: 26rem; }
</style>
</head>
<body><main><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

/**
 * Response hardening for the consent surface. No-store + no-referrer because
 * the handle is in the URL (don't cache or leak it); frame-denial because a
 * security *decision* page must never be clickjackable — an attacker framing
 * it to trick an "approve" click would mint a credential to an allowlisted
 * origin behind the user's back.
 */
function consentPageHeaders(c: Context<HonoEnv>): void {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
}

/**
 * GET /auth/connect/consent?pending=<handle>
 *
 * The disclosure page (ADR 0024 §3). Reads the pending connection **without
 * consuming it** (idempotent render) and shows what is connecting, with an
 * Approve/Decline form. This is the one branding floor a client cannot skip:
 * the shared identity discloses the connection on its own surface before any
 * credential exists.
 */
export async function handleConnectConsent(c: Context<HonoEnv>) {
    consentPageHeaders(c);
    const handle = c.req.query('pending') ?? '';
    if (!handle) {
        return c.html(renderConsentError('This connection link is missing.'), 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const pending = await GetPendingConnection(c.env.DJIBB_AUTH, handle, now);
    if (!pending) {
        return c.html(
            renderConsentError(
                'This connection request has expired or was already used. ' +
                    'Start again from the app you were connecting.',
            ),
            410,
        );
    }
    // Re-validate the origin at render time too (defense in depth, matching the
    // POST handler): if the allowlist was tightened after the ceremony started,
    // never present a now-untrusted origin as a legitimate connection request.
    if (!originIsAllowlisted(c.env.AUTHORIZED_DOMAINS, pending.client_origin)) {
        console.error(
            '`handleConnectConsent()` pending for unauthorized origin "%s"',
            pending.client_origin,
        );
        return c.html(
            renderConsentError('This connection can no longer be completed.'),
            400,
        );
    }
    return c.html(renderConsentPage(handle, pending));
}

/** Build the client redirect after a consent decision. */
function verifiedRedirectUrl(
    origin: string,
    params: Record<string, string>,
): string {
    const url = new URL(`${origin}/accounts/verified`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
}

/**
 * POST /auth/connect/consent   (form-encoded: handle, decision)
 *
 * The decision point (§3). Claims the pending connection once (approve OR
 * decline spends it), then:
 *  - **approve** → mints the authorization code #28 defined and redirects it
 *    to the client's origin (`/accounts/verified?code=`);
 *  - **decline** (or any non-approve value) → mints nothing and redirects
 *    with `?error=access_denied`, so the client learns the ceremony was
 *    abandoned. No code, and therefore no credential, ever exists.
 *
 * CSRF-exempt (see `src/index.ts`): the form posts from this worker-owned
 * page whose Origin is the API origin (not in `AUTHORIZED_DOMAINS`), and its
 * authenticity is the single-use `handle` — a secret only the browser that
 * completed the ceremony was ever handed.
 */
export async function handleConnectConsentSubmit(c: Context<HonoEnv>) {
    consentPageHeaders(c);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const handle = typeof form.handle === 'string' ? form.handle : '';
    const decision = typeof form.decision === 'string' ? form.decision : '';
    if (!handle) {
        return c.html(renderConsentError('This connection link is missing.'), 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const pending = await ConsumePendingConnection(c.env.DJIBB_AUTH, handle, now);
    if (!pending) {
        return c.html(
            renderConsentError(
                'This connection request has expired or was already used. ' +
                    'Start again from the app you were connecting.',
            ),
            410,
        );
    }

    // Re-validate the redirect target at decision time (defense in depth): the
    // allowlist may have changed since ceremony start, and we never redirect
    // to an origin that isn't known-good right now.
    if (!originIsAllowlisted(c.env.AUTHORIZED_DOMAINS, pending.client_origin)) {
        console.error(
            '`handleConnectConsentSubmit()` pending for unauthorized origin "%s"',
            pending.client_origin,
        );
        return c.html(
            renderConsentError('This connection can no longer be completed.'),
            400,
        );
    }

    // Any non-approve decision declines — a malformed/unknown value must never
    // mint. Decline is terminal: the handle is already spent above.
    if (decision !== 'approve') {
        return c.redirect(
            verifiedRedirectUrl(pending.client_origin, {
                error: 'access_denied',
            }),
        );
    }

    const { code } = await InsertAuthorizationCode(c.env.DJIBB_AUTH, {
        accountId: pending.account_id,
        clientOrigin: pending.client_origin,
        codeChallenge: pending.code_challenge,
        label: pending.label,
        boundEntityId: pending.bound_entity_id,
        now,
    });
    return c.redirect(
        verifiedRedirectUrl(pending.client_origin, { code }),
    );
}
