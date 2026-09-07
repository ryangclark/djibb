/**
 * Framework-thin adapter over the Workers Rate Limiting bindings (GH #14,
 * #40). The bindings themselves (`RL_ANON_WRITE`, `RL_ACCT_WRITE`,
 * `RL_AUTH_IP`) are declared in `wrangler.toml` under `[[ratelimits]]`;
 * this is the one place request handlers touch them.
 *
 * The Workers binding does the real, always-on work: a per-key sliding
 * window with zero storage cost, per-colo (not globally exact — irrelevant
 * for abuse mitigation). The complementary Cloudflare WAF edge layer is a
 * dashboard runbook, not code — see `src/auth/README.md`.
 *
 * Deliberately NOT the D1 magic-link limiter (`checkRateLimits`,
 * `auth/d1.ts`): that stays scoped to the rare email path. Extending it to
 * these hot paths would make per-request D1 writes the new bottleneck,
 * defeating #14.
 */
import type { Context } from 'hono';

import type { HonoEnv } from '..';

/**
 * The default `Retry-After` hint, in seconds. The Workers binding reports
 * only `success` — not when the window reopens — so we surface the
 * binding's `period` (60s for all three; see `wrangler.toml`) as an honest
 * upper bound. Callers gating a 10s-period binding should pass `10`.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * The IP the request came from, for IP-keyed limits. `CF-Connecting-IP` is
 * the trusted client IP at Cloudflare's edge (same source used by
 * `handleSudoRequest` and `magic.ts`). The fallback keeps every IP-less
 * request (local `wrangler dev`, odd proxies) sharing one brutal bucket
 * rather than each getting its own unthrottled key.
 */
export function clientIp(c: Context<HonoEnv>): string {
    return c.req.header('CF-Connecting-IP') ?? 'unknown-ip';
}

/**
 * Charge one hit against `binding` for `key`. Returns a `429` `Response`
 * when the key is over its window, else `null` (caller proceeds).
 *
 * The 429 body mirrors the magic-link limiter's shape
 * (`{ error: 'rate_limited', retry_after_seconds }` + `Retry-After`
 * header) so the existing client handling applies unchanged
 * (`DjibbHttpError` / `MagicLinkRateLimitError` already read
 * `retry_after_seconds` and `Retry-After`).
 */
export async function enforceLimit(
    c: Context<HonoEnv>,
    binding: RateLimit,
    key: string,
    retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS,
): Promise<Response | null> {
    const { success } = await binding.limit({ key });
    if (success) return null;

    c.header('Retry-After', String(retryAfterSeconds));
    return c.json(
        {
            error: 'rate_limited',
            retry_after_seconds: retryAfterSeconds,
        },
        429,
    );
}
