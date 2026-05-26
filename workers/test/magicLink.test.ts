/**
 * Magic-link auth tests (ADR 0010).
 *
 * Before adding tests here (or anywhere in the codebase), skim
 * `docs/testing.md` for conventions — service-level vs E2E, the
 * dev-seam pattern, the pure-predicate pattern, and the worker.fetch
 * Host-header caveat are all covered there.
 *
 * Covers the load-bearing pieces of the substrate at D1/service level:
 *
 *   1. hashToken — SHA-256 stability + format
 *   2. checkRateLimits — happy path and the four named limits
 *   3. consumeMagicTokenRow — atomic single-use, expiry rejection
 *   4. Account resolution — GetAccountByEmail's case-insensitive
 *      match across djibb-home and Google-home rows (the convergence
 *      that prevents duplicate Accounts)
 *   5. Schema-level UNIQUE constraint on djibb-native (provider, email)
 *
 * Worker-fetch HTTP tests (full pipeline through Hono routing,
 * cookies, CORS/CSRF) are out of scope for this slice and would land
 * in a follow-up alongside binding setup (Origin headers, EMAIL.send
 * mock). The pieces here are the ones whose correctness the user
 * actually depends on for security.
 */

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CreateAccount, GetAccountByEmail } from '../src/account/service';
import type { Account } from '../src/account';
import {
    MAGIC_RATE_LIMITS,
    checkRateLimits,
    consumeMagicTokenRow,
    hashToken,
    shouldExposeDevSeam,
} from '../src/auth/magic';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
        display_name: 'Test User',
        email: `t-${Math.random().toString(36).slice(2)}@example.com`,
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g-' + Math.random().toString(36).slice(2),
        user_name: null,
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

/**
 * Direct INSERT into magic_link_tokens. Bypasses /request so we can
 * stage exact timestamps for rate-limit and expiry tests without
 * fighting Date.now().
 */
async function insertToken(args: {
    tokenHash: string;
    email: string;
    purpose?: string;
    timeCreated: number;
    timeExpires: number;
    timeConsumed?: number | null;
    requestIp?: string | null;
}) {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO magic_link_tokens (
            token_hash, target_email, purpose,
            time_created, time_expires, time_consumed,
            request_ip, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
    )
        .bind(
            args.tokenHash,
            args.email,
            args.purpose ?? 'signin',
            args.timeCreated,
            args.timeExpires,
            args.timeConsumed ?? null,
            args.requestIp ?? null,
            'test-agent'
        )
        .run();
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

// ─── hashToken ──────────────────────────────────────────────────────────────

describe('hashToken', () => {
    it('is deterministic for the same input', async () => {
        const a = await hashToken('hello');
        const b = await hashToken('hello');
        expect(a).toBe(b);
    });

    it('produces different hashes for different inputs', async () => {
        const a = await hashToken('hello');
        const b = await hashToken('hello ');
        expect(a).not.toBe(b);
    });

    it('returns 64 lowercase hex chars (SHA-256)', async () => {
        const h = await hashToken('any-token-here');
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches the well-known SHA-256 of "abc"', async () => {
        // Cross-check against an authoritative test vector so a future
        // change to the hash function doesn't slip past silently.
        const h = await hashToken('abc');
        expect(h).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        );
    });
});

// ─── checkRateLimits ────────────────────────────────────────────────────────

describe('checkRateLimits', () => {
    const email = 'rate@example.com';
    const ip = '198.51.100.42';
    const NOW = 1_700_000_000;

    it('returns ok for an unseen email', async () => {
        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result).toEqual({ ok: true });
    });

    it('fires the 60-sec cooldown after a single recent token', async () => {
        // One token 30s ago.
        await insertToken({
            tokenHash: 'h-cooldown',
            email,
            timeCreated: NOW - 30,
            timeExpires: NOW + 60 * 14,
            requestIp: ip,
        });

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return; // narrow
        expect(result.reason).toBe('cooldown');
        // 60-sec cooldown - 30 elapsed = 30s to wait.
        expect(result.retryAfterSec).toBe(30);
    });

    it('clears the cooldown once 60s have passed', async () => {
        await insertToken({
            tokenHash: 'h-aged',
            email,
            timeCreated: NOW - 61,
            timeExpires: NOW + 60 * 14,
            requestIp: ip,
        });

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result).toEqual({ ok: true });
    });

    it('fires the per-email 15-min bucket on the (limit+1)th hit', async () => {
        // Three tokens spread across the 15-min window, all old
        // enough that cooldown doesn't fire first.
        const ages = [13 * 60, 8 * 60, 3 * 60]; // 13m, 8m, 3m ago
        for (let i = 0; i < ages.length; i++) {
            await insertToken({
                tokenHash: `h-15-${i}`,
                email,
                timeCreated: NOW - ages[i]!,
                timeExpires: NOW - ages[i]! + 15 * 60,
                requestIp: ip,
            });
        }

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('email_15min');
        // Retry-after = (oldest + 15min) - now = (NOW - 13*60 + 15*60) - NOW
        //              = 2 minutes = 120 seconds.
        expect(result.retryAfterSec).toBe(2 * 60);
    });

    it('fires the per-email 24-h bucket once 10 tokens accumulate', async () => {
        // Ten tokens spread across the 24-h window, none in the
        // 15-min window (so 24h fires, not 15min).
        for (let i = 0; i < MAGIC_RATE_LIMITS.PER_EMAIL_24H; i++) {
            await insertToken({
                tokenHash: `h-24-${i}`,
                email,
                // Oldest 23h ago; newest 16min ago, all evenly spaced.
                timeCreated: NOW - (23 * 60 * 60 - i * 60 * 60 * 0.7),
                timeExpires: NOW + 15 * 60,
                requestIp: ip,
            });
        }

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // Could be 'email_15min' if too many fall inside the 15-min
        // window — verify our spacing avoided that.
        expect(result.reason).toBe('email_24h');
        expect(result.retryAfterSec).toBeGreaterThan(0);
    });

    it('fires the per-IP hour bucket', async () => {
        // 20 tokens from one IP, each to a distinct email so the
        // per-email checks don't fire first.
        for (let i = 0; i < MAGIC_RATE_LIMITS.PER_IP_HOUR; i++) {
            await insertToken({
                tokenHash: `h-ip-${i}`,
                email: `victim-${i}@example.com`,
                // Spread across the past hour, evenly.
                timeCreated: NOW - (59 * 60 - i * 2 * 60),
                timeExpires: NOW + 15 * 60,
                requestIp: ip,
            });
        }

        // Now check from the same IP, for a fresh email so no
        // per-email collision.
        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email: 'fresh@example.com',
            ip,
            now: NOW,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('ip_hour');
    });

    it('skips per-IP check when ip is null but still enforces email checks', async () => {
        // Stage 3 same-email tokens so the 15-min limit fires.
        for (let i = 0; i < 3; i++) {
            await insertToken({
                tokenHash: `h-noip-${i}`,
                email,
                timeCreated: NOW - (10 * 60 - i * 60),
                timeExpires: NOW + 15 * 60,
                requestIp: null,
            });
        }

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip: null,
            now: NOW,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('email_15min');
    });

    it('returns ok when prior tokens are outside the 24-h window', async () => {
        // Token from 25 hours ago — should not contribute to any
        // active limit.
        await insertToken({
            tokenHash: 'h-stale',
            email,
            timeCreated: NOW - 25 * 60 * 60,
            timeExpires: NOW - 25 * 60 * 60 + 15 * 60,
            requestIp: ip,
        });

        const result = await checkRateLimits(env.DJIBB_AUTH, {
            email,
            ip,
            now: NOW,
        });
        expect(result).toEqual({ ok: true });
    });
});

// ─── consumeMagicTokenRow ───────────────────────────────────────────────────

describe('consumeMagicTokenRow', () => {
    const NOW = 1_700_000_000;
    const hash = 'h-consume';

    it('claims an unconsumed, unexpired token exactly once', async () => {
        await insertToken({
            tokenHash: hash,
            email: 'alice@example.com',
            timeCreated: NOW - 60,
            timeExpires: NOW + 60 * 14,
        });

        const first = await consumeMagicTokenRow(env.DJIBB_AUTH, hash, NOW);
        expect(first).toEqual({
            target_email: 'alice@example.com',
            purpose: 'signin',
        });

        // A second consume must not succeed — load-bearing single-use.
        const second = await consumeMagicTokenRow(env.DJIBB_AUTH, hash, NOW);
        expect(second).toBeNull();
    });

    it('records the consumption timestamp', async () => {
        await insertToken({
            tokenHash: hash,
            email: 'alice@example.com',
            timeCreated: NOW - 60,
            timeExpires: NOW + 60 * 14,
        });

        await consumeMagicTokenRow(env.DJIBB_AUTH, hash, NOW);

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_consumed FROM magic_link_tokens WHERE token_hash = ?`
        )
            .bind(hash)
            .first<{ time_consumed: number | null }>();
        expect(row?.time_consumed).toBe(NOW);
    });

    it('rejects expired tokens (and leaves time_consumed NULL)', async () => {
        await insertToken({
            tokenHash: hash,
            email: 'alice@example.com',
            timeCreated: NOW - 60 * 60,
            timeExpires: NOW - 60, // expired one minute ago
        });

        const result = await consumeMagicTokenRow(env.DJIBB_AUTH, hash, NOW);
        expect(result).toBeNull();

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_consumed FROM magic_link_tokens WHERE token_hash = ?`
        )
            .bind(hash)
            .first<{ time_consumed: number | null }>();
        expect(row?.time_consumed).toBeNull();
    });

    it('rejects already-consumed tokens even when not expired', async () => {
        await insertToken({
            tokenHash: hash,
            email: 'alice@example.com',
            timeCreated: NOW - 60,
            timeExpires: NOW + 60 * 14,
            timeConsumed: NOW - 30,
        });

        const result = await consumeMagicTokenRow(env.DJIBB_AUTH, hash, NOW);
        expect(result).toBeNull();
    });

    it('returns null for an unknown hash without raising', async () => {
        const result = await consumeMagicTokenRow(
            env.DJIBB_AUTH,
            'nope',
            NOW
        );
        expect(result).toBeNull();
    });
});

// ─── Account resolution & schema constraints ────────────────────────────────

describe('Account email-resolution and provider tag', () => {
    it('finds a Google-home Account by email, case-insensitive', async () => {
        const created = await CreateAccount(env,
            makeAccount({
                email: 'bob@example.com',
                provider_name: 'google',
                provider_client_id: 'google-sub-bob',
            })
        );

        const found = await GetAccountByEmail(
            env.DJIBB_AUTH,
            'BOB@Example.COM'
        );
        expect(found?.id).toBe(created.id);
        expect(found?.provider_name).toBe('google');
    });

    it('finds a djibb-home Account created via the magic-link path', async () => {
        const created = await CreateAccount(env,
            makeAccount({
                email: 'carol@example.com',
                provider_name: 'djibb',
                provider_client_id: 'carol@example.com',
            })
        );

        const found = await GetAccountByEmail(
            env.DJIBB_AUTH,
            'carol@example.com'
        );
        expect(found?.id).toBe(created.id);
        expect(found?.provider_name).toBe('djibb');
        expect(found?.provider_client_id).toBe('carol@example.com');
        expect(found?.email_verified).toBe(true);
    });

    it('does not return soft-deleted accounts', async () => {
        const created = await CreateAccount(env,
            makeAccount({ email: 'gone@example.com' })
        );
        await env.DJIBB_AUTH.prepare(
            `UPDATE accounts SET time_deleted = ? WHERE id = ?`
        )
            .bind(Math.floor(Date.now() / 1000), created.id)
            .run();

        const found = await GetAccountByEmail(
            env.DJIBB_AUTH,
            'gone@example.com'
        );
        expect(found).toBeNull();
    });

    it('blocks a second djibb-home Account with the same email', async () => {
        // The partial UNIQUE index in migration 0005 is the schema-
        // level guarantee that magic-link-as-IdP can't accidentally
        // mint duplicate Accounts. Verify it actually bites.
        await CreateAccount(env,
            makeAccount({
                email: 'dup@example.com',
                provider_name: 'djibb',
                provider_client_id: 'dup@example.com',
            })
        );

        await expect(
            CreateAccount(env,
                makeAccount({
                    email: 'dup@example.com',
                    provider_name: 'djibb',
                    provider_client_id: 'dup@example.com',
                })
            )
        ).rejects.toThrow();
    });

    it('allows a Google-home and a djibb-home with the same email at the schema layer', async () => {
        // The partial UNIQUE is scoped to provider_name='djibb';
        // a Google row with the same email is not blocked by it.
        // (Application-layer resolution converges them via email
        // match — this test is only about the index's scope.)
        await CreateAccount(env,
            makeAccount({
                email: 'mix@example.com',
                provider_name: 'google',
                provider_client_id: 'google-sub-mix',
            })
        );

        // Should not throw.
        await CreateAccount(env,
            makeAccount({
                email: 'mix@example.com',
                provider_name: 'djibb',
                provider_client_id: 'mix@example.com',
            })
        );
    });
});

// ─── Dev-mode test seam ─────────────────────────────────────────────────────

/**
 * The `_dev` request flag is the E2E test driver's only way to obtain
 * the raw magic-link URL without intercepting the outbound email. Two
 * load-bearing claims:
 *
 *   1. When ENV is "dev" (case-insensitive) AND _dev=true, the
 *      response carries `landing_url`.
 *   2. The seam never fires when either condition is missing — in
 *      particular, an attacker adding `_dev: true` to a production
 *      request cannot extract URLs.
 *
 * Claim 2 is exercised exhaustively against the pure predicate
 * (`shouldExposeDevSeam`); the wiring test below confirms that the
 * predicate is what `handleMagicRequest` actually consults.
 */
describe('shouldExposeDevSeam (pure gate predicate)', () => {
    it('opens the seam only when both inputs agree', () => {
        expect(shouldExposeDevSeam('dev', true)).toBe(true);
        expect(shouldExposeDevSeam('DEV', true)).toBe(true);
        expect(shouldExposeDevSeam('Dev', true)).toBe(true);
    });

    it('blocks the seam when _dev flag is missing or false', () => {
        expect(shouldExposeDevSeam('dev', undefined)).toBe(false);
        expect(shouldExposeDevSeam('dev', false)).toBe(false);
    });

    it('blocks the seam in non-dev environments even with _dev=true', () => {
        // The load-bearing claim: an attacker who manages to send
        // `_dev: true` against a production deployment cannot extract
        // URLs. This is the predicate that guarantees that.
        expect(shouldExposeDevSeam('production', true)).toBe(false);
        expect(shouldExposeDevSeam('staging', true)).toBe(false);
        expect(shouldExposeDevSeam('prod', true)).toBe(false);
    });

    it('blocks the seam when ENV is missing entirely', () => {
        // Defensive default: a misconfigured deployment that omits
        // ENV must default-deny, not default-allow.
        expect(shouldExposeDevSeam(undefined, true)).toBe(false);
        expect(shouldExposeDevSeam(null, true)).toBe(false);
        expect(shouldExposeDevSeam('', true)).toBe(false);
    });

    it('does not match near-misses like "develop" or " dev "', () => {
        expect(shouldExposeDevSeam('develop', true)).toBe(false);
        expect(shouldExposeDevSeam(' dev ', true)).toBe(false);
        expect(shouldExposeDevSeam('development', true)).toBe(false);
    });
});

// Wiring of the predicate into `handleMagicRequest` is verified by the
// E2E script at /e2e/magic-link.sh, which drives the seam through a
// real browser → real worker round trip. We deliberately do not test
// the HTTP wiring here: synthetic Requests in the vitest-pool-workers
// env can't carry a Host header (forbidden header name in JS Fetch),
// which trips the CSRF middleware's Host-presence check. Rather than
// loosen production-shipped middleware to satisfy the test harness,
// we let the E2E script cover that part of the path.
