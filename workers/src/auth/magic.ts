/**
 * Magic-link authentication handlers (ADR 0010).
 *
 * Three endpoints form the v1 substrate:
 *
 *   POST /auth/magic/request   — mint+email a token (always 200; never
 *                                leaks whether the address is known).
 *   GET  /auth/magic/land      — interstitial "Click to sign in" page.
 *                                Defeats mail-scanner GET-prefetch by
 *                                requiring a user-initiated POST to
 *                                actually consume the token.
 *   POST /auth/magic/consume   — verify token, resolve-or-create the
 *                                Account by verified email, mint a
 *                                fresh session, redirect home.
 *
 * Raw tokens live only inside the emailed URL. D1 stores SHA-256(raw)
 * keyed as PRIMARY KEY, so a database read cannot mint live sessions.
 * Single-use is enforced by `time_consumed`; expiry is enforced lazily
 * on read.
 *
 * Rate limiting is intentionally a thin stub here — the schema indexes
 * support it (`idx_magic__by_email_time`), but the limits named in
 * ADR 0010 (per-email 3/15min and 10/24h, per-IP 20/hour, 60-sec
 * resend cooldown) are not yet enforced. They'll land alongside the
 * sign-in UI in a follow-up commit so the surfaces can co-evolve.
 */

import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';

import type { HonoEnv } from '..';
import { BadRequestError, UnexpectedError, ValidationError } from '../errors';
import {
    CreateAccount,
    GetAccountByEmail,
} from '../account/service';
import { CreateSession } from './session';
import { randomString } from '../id';
import {
    BaseSessionCookieAttributes,
    CookieNames,
    OAUTH_PROVIDER,
} from './constants';

// ─── Tunables ───────────────────────────────────────────────────────────────

const TOKEN_LENGTH = 32; // ~192 bits over the 64-char URL-safe alphabet.
const TOKEN_TTL_SECONDS = 15 * 60; // ADR 0010 policy default.
const MAGIC_PURPOSE_SIGNIN = 'signin';

/**
 * Rate-limit policy (ADR 0010).
 *
 * All limits apply to /request (token mint + email send). /consume
 * is not rate-limited here — a flood of consume attempts against a
 * harvested-but-unknown-hash space is bounded by the SHA-256 keyspace,
 * not by request volume.
 *
 * Limits are enforced by counting rows in `magic_link_tokens` over
 * a window. Rows are not purged on consume (the row's lifecycle is
 * its own — see the `time_consumed` column), so the count over a
 * window is a faithful "how many tokens did this target generate
 * recently?" regardless of how many were actually clicked.
 */
export const MAGIC_RATE_LIMITS = {
    /** Min seconds between successive /request calls for the same email. */
    PER_EMAIL_COOLDOWN_SEC: 60,
    /** Max /request calls per email in a 15-minute window. */
    PER_EMAIL_15MIN: 3,
    PER_EMAIL_15MIN_WINDOW_SEC: 15 * 60,
    /** Max /request calls per email in a 24-hour window. */
    PER_EMAIL_24H: 10,
    PER_EMAIL_24H_WINDOW_SEC: 24 * 60 * 60,
    /** Max /request calls per IP in a 1-hour window. */
    PER_IP_HOUR: 20,
    PER_IP_HOUR_WINDOW_SEC: 60 * 60,
} as const;

/**
 * Reason codes returned when a /request call is rate-limited. Surfaced
 * to clients (the sign-in UI maps these to user-visible messages) and
 * useful for log analysis.
 */
export type RateLimitReason =
    | 'cooldown' // 60-sec same-email cooldown
    | 'email_15min' // per-email 15-min bucket
    | 'email_24h' // per-email 24-hour bucket
    | 'ip_hour'; // per-IP 1-hour bucket

type RateLimitResult =
    | { ok: true }
    | { ok: false; reason: RateLimitReason; retryAfterSec: number };

// Email matching — pragmatic shape check, not RFC 5321 compliant.
// Verification of *deliverability* happens implicitly: an attacker
// who can't read the inbox can't complete the flow.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Schemas ────────────────────────────────────────────────────────────────

const RequestBodySchema = z.object({
    email: z.string().trim().min(3).max(254),
    next: z.string().optional(), // post-signin destination path
    /**
     * Dev-mode test seam: when set, AND `c.env.ENV === 'dev'`, the
     * response includes the raw landing URL so an E2E test driver
     * can drive the click-through interstitial without having to
     * intercept the outbound email. Honored exclusively in dev — see
     * the env check in `handleMagicRequest` below. The schema accepts
     * the flag in any environment so prod requests don't 400; the
     * env check is what makes prod ignore it.
     */
    _dev: z.boolean().optional(),
});

const ConsumeBodySchema = z.object({
    token: z.string().min(8).max(128),
    next: z.string().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * SHA-256(raw token) → hex. Stored at rest; raw token never persisted.
 *
 * Exported for test access; the function is deterministic and pure,
 * so tests can assert hash stability without spinning up D1.
 */
export async function hashToken(raw: string): Promise<string> {
    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The dev-seam gate.
 *
 * Returns true only when *both*:
 *  - the deployment is a dev environment (ENV value, case-insensitive,
 *    equals "dev"). Note: real prod must never set ENV to "dev" or
 *    "DEV". The check is case-insensitive purely to tolerate the
 *    existing convention mismatch (.dev.vars uses "DEV"; oauth.ts
 *    historically checks for lowercase "dev").
 *  - the caller has opted in by sending `_dev: true` in the request
 *    body. Ordinary dev traffic from the sign-in UI does NOT set
 *    this flag, so a developer signing in normally still gets the
 *    soft-200 with no body — preserving the existence-disclosure
 *    invariant on routine traffic.
 *
 * Extracted as a named, pure predicate so the production-safety
 * claim has a place to be unit-tested directly: every (envValue,
 * devFlag) combination can be exercised without the surrounding
 * HTTP machinery.
 */
export function shouldExposeDevSeam(
    envValue: string | undefined | null,
    devFlag: boolean | undefined
): boolean {
    if (devFlag !== true) return false;
    if (envValue == null) return false;
    return String(envValue).toLowerCase() === 'dev';
}

/**
 * Atomically claim a magic-link token by its SHA-256 hash.
 *
 * Single UPDATE...RETURNING: if zero rows match, the token is
 * either unknown, already consumed, or expired — the caller treats
 * all three as the same "invalid token" failure (distinguishing
 * them would help attackers triangulate token state).
 *
 * Exported for unit tests that exercise the single-use and
 * expiry contracts directly against D1.
 *
 * @returns the row's `target_email` and `purpose` on success, or
 *          `null` if no eligible row was found.
 */
export async function consumeMagicTokenRow(
    d1: D1Database,
    tokenHash: string,
    now: number
): Promise<{ target_email: string; purpose: string } | null> {
    return d1
        .prepare(
            `UPDATE magic_link_tokens
                SET time_consumed = ?
                WHERE token_hash = ?
                    AND time_consumed IS NULL
                    AND time_expires > ?
                RETURNING target_email, purpose;`
        )
        .bind(now, tokenHash, now)
        .first<{ target_email: string; purpose: string }>();
}

/**
 * Sanitize an arbitrary `next` param to a local path.
 *
 * Accepts only paths that start with a single `/` (and not `//`, which
 * would be a protocol-relative redirect to an attacker domain). Falls
 * back to `/` if anything looks off. Mirrors the OAuth-callback
 * behavior of constraining the redirect surface.
 */
function sanitizeNext(next: string | undefined): string {
    if (!next || typeof next !== 'string') return '/';
    if (!next.startsWith('/') || next.startsWith('//')) return '/';
    if (next.includes('\\')) return '/';
    return next;
}

/**
 * Build a sign-in landing URL on the *frontend* origin. The
 * frontend renders the click-through interstitial; the worker only
 * serves the API for /consume. (We don't render HTML from the worker
 * for the click page because session cookies live on the API origin
 * and we want the click + POST to land cleanly through the existing
 * CORS+CSRF middleware path.)
 *
 * Wait — actually the interstitial *does* run on the API origin so
 * the consume POST is same-origin. See `handleMagicLand` below for
 * the rendered page. The link in the email points here, not to the
 * frontend, on purpose.
 */
function buildLandingUrl(c: Context<HonoEnv>, rawToken: string, next: string): string {
    const u = new URL(`${c.env.API_ORIGIN}/auth/magic/land`);
    u.searchParams.set('token', rawToken);
    if (next && next !== '/') u.searchParams.set('next', next);
    return u.toString();
}

/**
 * Run the four rate-limit checks against `magic_link_tokens` (ADR 0010).
 *
 * Strategy: one query fetches the per-email timestamps inside the
 * 24-hour window (the widest email-bucket); the three email-bucket
 * checks (cooldown, 15-min, 24-h) are derived from that single
 * result. A second query covers the per-IP bucket.
 *
 * Total: 1–2 D1 reads per /request, both indexed
 * (idx_magic__by_email_time, idx_magic__by_ip_time). Cheap.
 *
 * Returns the *first* limit hit; we don't continue past a block.
 * Retry-after values are the precise number of seconds until that
 * specific limit relaxes — `Math.ceil((oldest_in_window + window)
 * - now)` — so the UI can show an accurate countdown.
 */
export async function checkRateLimits(
    d1: D1Database,
    args: { email: string; ip: string | null; now: number }
): Promise<RateLimitResult> {
    const { email, ip, now } = args;
    const since24h = now - MAGIC_RATE_LIMITS.PER_EMAIL_24H_WINDOW_SEC;

    // Pull all per-email timestamps inside the widest (24h) window.
    // DESC ordering lets us check the cooldown (top row) and the
    // 15-min bucket (top N rows) without re-querying.
    const emailRows = await d1
        .prepare(
            `SELECT time_created
                FROM magic_link_tokens
                WHERE target_email = ?
                    AND time_created >= ?
                ORDER BY time_created DESC;`
        )
        .bind(email, since24h)
        .all<{ time_created: number }>();

    const emailTimes = emailRows.results.map(r => r.time_created);

    // 1) 60-sec cooldown — only relevant to the single most recent token.
    if (emailTimes.length > 0) {
        const lastAge = now - emailTimes[0]!;
        if (lastAge < MAGIC_RATE_LIMITS.PER_EMAIL_COOLDOWN_SEC) {
            return {
                ok: false,
                reason: 'cooldown',
                retryAfterSec: Math.max(
                    1,
                    MAGIC_RATE_LIMITS.PER_EMAIL_COOLDOWN_SEC - lastAge
                ),
            };
        }
    }

    // 2) 15-min bucket — count entries inside the 15-min window.
    const since15min = now - MAGIC_RATE_LIMITS.PER_EMAIL_15MIN_WINDOW_SEC;
    const in15min = emailTimes.filter(t => t >= since15min);
    if (in15min.length >= MAGIC_RATE_LIMITS.PER_EMAIL_15MIN) {
        // Oldest of the in-window tokens is the one whose ageout
        // would free up a slot. emailTimes is DESC, so the last
        // element in in15min is the oldest in-window.
        const oldest = in15min[in15min.length - 1]!;
        const ageout =
            oldest + MAGIC_RATE_LIMITS.PER_EMAIL_15MIN_WINDOW_SEC - now;
        return {
            ok: false,
            reason: 'email_15min',
            retryAfterSec: Math.max(1, ageout),
        };
    }

    // 3) 24-h bucket — count is just emailTimes.length (already
    //    filtered to the 24-h window in the query above).
    if (emailTimes.length >= MAGIC_RATE_LIMITS.PER_EMAIL_24H) {
        const oldest = emailTimes[emailTimes.length - 1]!;
        const ageout =
            oldest + MAGIC_RATE_LIMITS.PER_EMAIL_24H_WINDOW_SEC - now;
        return {
            ok: false,
            reason: 'email_24h',
            retryAfterSec: Math.max(1, ageout),
        };
    }

    // 4) Per-IP bucket. Skipped when we couldn't capture an IP — the
    //    other three limits still apply, so this isn't a bypass.
    if (ip) {
        const sinceIPHour = now - MAGIC_RATE_LIMITS.PER_IP_HOUR_WINDOW_SEC;
        const ipRows = await d1
            .prepare(
                `SELECT time_created
                    FROM magic_link_tokens
                    WHERE request_ip = ?
                        AND time_created >= ?
                    ORDER BY time_created ASC
                    LIMIT ?;`
            )
            .bind(ip, sinceIPHour, MAGIC_RATE_LIMITS.PER_IP_HOUR)
            .all<{ time_created: number }>();

        if (ipRows.results.length >= MAGIC_RATE_LIMITS.PER_IP_HOUR) {
            const oldest = ipRows.results[0]!.time_created;
            const ageout =
                oldest + MAGIC_RATE_LIMITS.PER_IP_HOUR_WINDOW_SEC - now;
            return {
                ok: false,
                reason: 'ip_hour',
                retryAfterSec: Math.max(1, ageout),
            };
        }
    }

    return { ok: true };
}

/**
 * Pick the post-signin frontend origin to redirect to.
 *
 * We use the first authorized domain from `AUTHORIZED_DOMAINS` as the
 * canonical frontend. This matches how the OAuth callback handles
 * `referer_origin` validation — different mechanism (no cookie set
 * before the click), same constraint (only known-good origins).
 *
 * If we ever support multiple frontend origins (e.g., djibb.com +
 * sibling client app), the /request handler should accept a
 * `client_id` param and look up the origin from a registered-clients
 * table. Out of scope for v1.
 */
function pickFrontendOrigin(c: Context<HonoEnv>): string | null {
    const domains = c.env.AUTHORIZED_DOMAINS?.split(';').filter(Boolean);
    return domains?.[0] ?? null;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * POST /auth/magic/request
 *
 * Body: { email: string, next?: string }
 *
 * Returns 200 unconditionally on a well-formed request, even if the
 * email is unknown or the send fails. Information disclosure here
 * would leak "is X a registered user" to anyone with a guessable
 * address, which is worth more than the marginal UX of telling
 * legitimate users "we couldn't email you."
 */
export async function handleMagicRequest(c: Context<HonoEnv>) {
    const body = await c.req.json().catch(() => null);
    const parsed = RequestBodySchema.safeParse(body);

    if (!parsed.success) {
        throw new BadRequestError('invalid request');
    }

    const email = parsed.data.email.toLowerCase();
    const next = sanitizeNext(parsed.data.next);

    // Shape check. Anything malformed gets a soft 200 — same as the
    // unknown-email case, for the same disclosure-avoidance reason.
    if (!EMAIL_RE.test(email)) {
        return c.body(null, 200);
    }

    const ip = c.req.header('CF-Connecting-IP') ?? null;
    const now = Math.floor(Date.now() / 1000);

    // Rate-limit check (ADR 0010). On block, return 429 with an
    // honest reason and an accurate Retry-After. Unlike the
    // existence-disclosure invariant (which 200s on unknown email),
    // rate-limit responses don't leak Account state: the limits
    // apply to whoever is hitting that email or IP, regardless of
    // whether the email maps to a known Account.
    const limit = await checkRateLimits(c.env.DJIBB_AUTH, {
        email,
        ip,
        now,
    });
    if (!limit.ok) {
        c.header('Retry-After', String(limit.retryAfterSec));
        return c.json(
            {
                error: 'rate_limited',
                reason: limit.reason,
                retry_after_seconds: limit.retryAfterSec,
            },
            429
        );
    }

    const rawToken = randomString(TOKEN_LENGTH);
    const tokenHash = await hashToken(rawToken);
    const expires = now + TOKEN_TTL_SECONDS;

    try {
        await c.env.DJIBB_AUTH.prepare(
            `INSERT INTO magic_link_tokens (
                token_hash,
                target_email,
                purpose,
                time_created,
                time_expires,
                request_ip,
                user_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?);`
        )
            .bind(
                tokenHash,
                email,
                MAGIC_PURPOSE_SIGNIN,
                now,
                expires,
                ip,
                c.req.header('User-Agent') ?? null
            )
            .run();
    } catch (err) {
        // PK collision is astronomically unlikely with 32-char
        // urlAlphabet; if it happens, log and fall through to the
        // soft-200. Anything else is an unexpected error.
        console.error('`handleMagicRequest()` insert error:', err);
        return c.body(null, 200);
    }

    const landingUrl = buildLandingUrl(c, rawToken, next);

    try {
        await sendMagicLinkEmailLocal(c, email, landingUrl);
    } catch (err) {
        console.error('`handleMagicRequest()` email send error:', err);
        // Still 200 — see disclosure-avoidance comment above.
    }

    // Dev seam (ADR 0010 supplement): see `shouldExposeDevSeam` for
    // the gate. When both conditions hold, surface the raw landing
    // URL so E2E drivers can advance past the interstitial without
    // intercepting the outbound email. The seam is loud (logs) so
    // an accidental prod deploy that flips ENV to 'dev' is visible.
    if (shouldExposeDevSeam(c.env.ENV, parsed.data._dev)) {
        console.log(
            '`handleMagicRequest()` dev seam: returning landing_url ' +
                'for email=%s. This must not happen in production.',
            email
        );
        return c.json({ landing_url: landingUrl }, 200);
    }

    return c.body(null, 200);
}

/**
 * GET /auth/magic/land?token=<raw>&next=<path>
 *
 * Renders an interstitial page with a single button that POSTs to
 * /consume. We do NOT consume on GET — mail-scanner prefetch fetches
 * GETs (often blindly), so consuming on GET would burn live tokens.
 *
 * The page is intentionally minimal and self-contained. It lives on
 * the API origin so the consume POST is same-origin (cookies attach
 * cleanly through the existing middleware). Cache-Control: no-store
 * prevents any intermediary from holding onto the token.
 */
export function handleMagicLand(c: Context<HonoEnv>) {
    const rawToken = c.req.query('token') ?? '';
    const next = sanitizeNext(c.req.query('next'));

    // Don't validate the token here (would require a DB read and we'd
    // need to be careful not to mutate state). Hand it straight to
    // the form; /consume is the validator.
    if (!rawToken) {
        return c.html(renderLandingError('Missing sign-in token.'), 400);
    }

    const html = renderLanding(rawToken, next);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(html);
}

/**
 * POST /auth/magic/consume
 *
 * Body: { token: string, next?: string }
 *
 * Hashes the token, validates against D1, marks it consumed, then:
 *  - resolves the Account by email (ADR 0010 option C), or
 *  - creates a new djibb-native Account if none exists.
 *
 * On success: sets session cookie, redirects to a sanitized `next`
 * on the frontend origin.
 */
export async function handleMagicConsume(c: Context<HonoEnv>) {
    const body = await c.req.json().catch(() => null);
    const parsed = ConsumeBodySchema.safeParse(body);

    if (!parsed.success) {
        throw new BadRequestError('invalid request');
    }

    const rawToken = parsed.data.token;
    const next = sanitizeNext(parsed.data.next);
    const tokenHash = await hashToken(rawToken);
    const now = Math.floor(Date.now() / 1000);

    const updateResult = await consumeMagicTokenRow(
        c.env.DJIBB_AUTH,
        tokenHash,
        now
    );

    if (!updateResult) {
        throw new ValidationError('sign-in link is invalid or expired');
    }

    if (updateResult.purpose !== MAGIC_PURPOSE_SIGNIN) {
        // Other purposes (e.g., 'verify_email_change') route through
        // dedicated handlers. Don't accidentally sign anyone in via
        // a non-signin token.
        throw new ValidationError('sign-in link is invalid');
    }

    const email = updateResult.target_email.toLowerCase();

    // Resolve-or-create the Account. ADR 0010 option C:
    //   email is the matching key; Account ID is the contract boundary.
    let account = await GetAccountByEmail(c.env.DJIBB_AUTH, email);

    if (!account) {
        const localPart = email.split('@')[0] ?? email;
        try {
            account = await CreateAccount(c.env, {
                id: '',
                display_name: localPart,
                email,
                email_verified: true, // proof-of-control just demonstrated
                flags: null,
                image: '',
                provider_name: OAUTH_PROVIDER.enum.djibb,
                provider_client_id: email, // djibb-as-IdP handle = canonical email
                user_name: null,
                time_created: new Date(),
                time_deleted: null,
                time_updated: new Date(),
            });
        } catch (err) {
            console.error('`handleMagicConsume()` create-account error:', err);
            throw new UnexpectedError();
        }
    }

    // Mint session. Merge into any existing session so multi-Account-
    // per-session flows work (user adds a second Account by emailing
    // themselves a sign-in link from a logged-in tab).
    const existingSession = c.get('session');
    let session;
    try {
        session = await CreateSession(
            c.env.DJIBB_AUTH,
            {
                accounts: [account],
                ip_country: c.req.header('CF-IPCountry') || '',
            },
            existingSession?.id
        );
    } catch (err) {
        console.error('`handleMagicConsume()` create-session error:', err);
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, BaseSessionCookieAttributes);

    const frontendOrigin = pickFrontendOrigin(c);
    if (!frontendOrigin) {
        console.error('`handleMagicConsume()` no authorized frontend origin');
        throw new UnexpectedError();
    }

    return c.json({
        redirect: `${frontendOrigin}${next}`,
        account_id: account.id,
    });
}

// ─── Interstitial rendering ─────────────────────────────────────────────────

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderLanding(rawToken: string, next: string): string {
    const tokenAttr = escapeAttr(rawToken);
    const nextAttr = escapeAttr(next);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>Sign in to djibb</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { color: #555; }
  button { font: inherit; padding: 0.6rem 1.2rem; border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  button:hover { background: #333; }
  #err { color: #b00; margin-top: 1rem; display: none; }
</style>
</head>
<body>
<h1>Sign in to djibb</h1>
<p>Click the button below to complete sign-in.</p>
<form id="f" method="post" action="/auth/magic/consume">
  <input type="hidden" name="token" value="${tokenAttr}">
  <input type="hidden" name="next" value="${nextAttr}">
  <button type="submit">Sign me in</button>
</form>
<p id="err"></p>
<script>
  // Convert the form submit into a JSON POST so it goes through the
  // worker's existing CSRF/CORS middleware as a normal API request.
  document.getElementById('f').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/auth/magic/consume', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: ${JSON.stringify(rawToken)},
          next: ${JSON.stringify(next)}
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || ('Status ' + res.status));
      }
      const data = await res.json();
      window.location.replace(data.redirect);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign me in';
      const el = document.getElementById('err');
      el.textContent = 'Sign-in failed: ' + (err && err.message ? err.message : 'unknown error');
      el.style.display = 'block';
    }
  });
</script>
</body>
</html>`;
}

function renderLandingError(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in error — djibb</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
</style>
</head>
<body>
<h1>Sign-in error</h1>
<p>${escapeAttr(message)}</p>
</body>
</html>`;
}

// ─── Email send (thin wrapper around workers/src/email) ─────────────────────

/**
 * Local wrapper that calls into the shared email module. Kept as a
 * thin shim so the rate-limit / template-versioning concerns can grow
 * here without touching the request handler.
 */
async function sendMagicLinkEmailLocal(
    c: Context<HonoEnv>,
    email: string,
    landingUrl: string
): Promise<void> {
    const { sendMagicLinkEmail } = await import('../email');
    await sendMagicLinkEmail(c.env, {
        to: email,
        landingUrl,
        ttlMinutes: Math.floor(TOKEN_TTL_SECONDS / 60),
    });
}
