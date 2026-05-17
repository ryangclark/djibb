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

import { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { customAlphabet, urlAlphabet } from 'nanoid';
import { z } from 'zod';

import { HonoEnv } from '..';
import { BadRequestError, UnexpectedError, ValidationError } from '../errors';
import {
    CreateAccount,
    GetAccountByEmail,
} from '../account/service';
import { CreateSession } from './session';
import {
    BaseSessionCookieAttributes,
    CookieNames,
    OAUTH_PROVIDER,
} from './constants';

// ─── Tunables ───────────────────────────────────────────────────────────────

const TOKEN_LENGTH = 32; // ~190 bits over urlAlphabet — comfortable margin.
const TOKEN_TTL_SECONDS = 15 * 60; // ADR 0010 policy default.
const MAGIC_PURPOSE_SIGNIN = 'signin';

// nanoid customAlphabet matches the workspace-invitations convention.
const tokenGen = customAlphabet(urlAlphabet, TOKEN_LENGTH);

// Email matching — pragmatic shape check, not RFC 5321 compliant.
// Verification of *deliverability* happens implicitly: an attacker
// who can't read the inbox can't complete the flow.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Schemas ────────────────────────────────────────────────────────────────

const RequestBodySchema = z.object({
    email: z.string().trim().min(3).max(254),
    next: z.string().optional(), // post-signin destination path
});

const ConsumeBodySchema = z.object({
    token: z.string().min(8).max(128),
    next: z.string().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** SHA-256(raw token) → hex. Stored at rest; raw token never persisted. */
async function hashToken(raw: string): Promise<string> {
    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
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

    // TODO(rate-limit): query `magic_link_tokens` via
    // `idx_magic__by_email_time` to enforce ADR-0010 limits before
    // minting. Stubbed for now; see the file-header note.

    const rawToken = tokenGen();
    const tokenHash = await hashToken(rawToken);
    const now = Math.floor(Date.now() / 1000);
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
                c.req.header('CF-Connecting-IP') ?? null,
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

    // Atomically mark the token consumed. If zero rows are affected,
    // the token is either unknown, already consumed, or expired —
    // we return a single ValidationError without distinguishing the
    // three. Distinguishing would help legitimate users but also help
    // attackers triangulate token state.
    const updateResult = await c.env.DJIBB_AUTH.prepare(
        `UPDATE magic_link_tokens
            SET time_consumed = ?
            WHERE token_hash = ?
              AND time_consumed IS NULL
              AND time_expires > ?
            RETURNING target_email, purpose;`
    )
        .bind(now, tokenHash, now)
        .first<{ target_email: string; purpose: string }>();

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
            account = await CreateAccount(c.env.DJIBB_AUTH, {
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
