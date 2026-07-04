/**
 * Issued-credentials substrate tests (ADR 0022 §4, GH #16).
 *
 * Skim `docs/testing.md` before extending — service-level vs E2E, the
 * direct-D1-staging pattern for time-sensitive cases, etc.
 *
 * These cover the load-bearing security claims of the substrate at the
 * D1/service level (the request→Account seam's verification half):
 *
 *   1. hashSecret — SHA-256 stability + format
 *   2. CreateCredential → VerifyBearerCredential round-trip resolves the
 *      token's Account
 *   3. Forged secret / unknown handle / malformed token are rejected
 *   4. Revoked and expired tokens are rejected
 *   5. bound_entity_id is carried forward onto the resolved credential
 *   6. The raw secret is never persisted (only SHA-256(raw))
 *   7. time_last_used is updated best-effort/throttled, not per request
 *
 * HTTP-pipeline wiring (the bearer header flowing through HandleSession
 * into a synthesized session) is verified by typecheck + the seam's own
 * shape; full worker.fetch coverage is out of scope for this slice (the
 * Host-header CSRF caveat in docs/testing.md applies to POST routes).
 */

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    CreateCredential,
    RevokeEntityBoundCredential,
    VerifyBearerCredential,
    credentialState,
    hashSecret,
    tokenBindsToEntity,
    type ResolvedCredential,
} from '../src/auth/credential';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Direct INSERT into `accounts` — bypasses CreateAccount (which also
 * mints a personal-workspace DO) so these tests stay scoped to the
 * credentials substrate. Mirrors CreateAccount's column set.
 */
async function insertAccount(
    overrides: { id?: string; email?: string } = {},
): Promise<string> {
    const id = overrides.id ?? newId('account');
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
            overrides.email ?? `t-${Math.random().toString(36).slice(2)}@example.com`,
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

async function readCredentialRow(credentialId: string) {
    return env.DJIBB_AUTH.prepare(
        'SELECT * FROM issued_credentials WHERE credential_id = ?',
    )
        .bind(credentialId)
        .first<Record<string, any>>();
}

// ─── hashSecret ──────────────────────────────────────────────────────────────

describe('hashSecret', () => {
    it('is deterministic and returns 64 lowercase hex chars', async () => {
        const a = await hashSecret('hello');
        const b = await hashSecret('hello');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches the well-known SHA-256 of "abc"', async () => {
        expect(await hashSecret('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('VerifyBearerCredential — happy path', () => {
    it('resolves a freshly-minted token to its Account', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: "Ryan's laptop CLI",
        });

        const resolved = await VerifyBearerCredential(env.DJIBB_AUTH, token);

        expect(resolved).not.toBeNull();
        expect(resolved!.account.id).toBe(accountId);
        expect(resolved!.credential_id).toBe(credentialId);
        expect(resolved!.bound_entity_id).toBeNull();
    });

    it('carries bound_entity_id forward onto the resolved credential', async () => {
        const accountId = await insertAccount();
        const listId = newId('list');
        const { token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            boundEntityId: listId,
        });

        const resolved = await VerifyBearerCredential(env.DJIBB_AUTH, token);
        expect(resolved!.bound_entity_id).toBe(listId);
    });
});

// ─── Rejection paths (all return null, never throw) ──────────────────────────

describe('VerifyBearerCredential — rejections', () => {
    it('rejects a forged secret for a real handle', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
        });

        const secret = token.split('.')[1]!;
        // Flip the secret while keeping the real handle + correct length.
        const forged = `${credentialId}.${'A'.repeat(secret.length)}`;
        expect(forged).not.toBe(token);

        expect(
            await VerifyBearerCredential(env.DJIBB_AUTH, forged),
        ).toBeNull();
    });

    it('rejects an unknown credential handle', async () => {
        const fake = `${newId('credential')}.${'a'.repeat(43)}`;
        expect(await VerifyBearerCredential(env.DJIBB_AUTH, fake)).toBeNull();
    });

    it('rejects malformed tokens', async () => {
        for (const bad of [
            '',
            'no-dot-here',
            'too.many.dots',
            `s/${'x'.repeat(21)}.${'a'.repeat(43)}`, // wrong id prefix
            `${newId('credential')}.short`, // wrong secret length
        ]) {
            expect(
                await VerifyBearerCredential(env.DJIBB_AUTH, bad),
            ).toBeNull();
        }
    });

    it('rejects a revoked token', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
        });

        await env.DJIBB_AUTH.prepare(
            'UPDATE issued_credentials SET time_revoked = ? WHERE credential_id = ?',
        )
            .bind(Math.floor(Date.now() / 1000), credentialId)
            .run();

        expect(await VerifyBearerCredential(env.DJIBB_AUTH, token)).toBeNull();
    });

    it('rejects an expired token but accepts one still in its window', async () => {
        const accountId = await insertAccount();
        const now = 1_700_000_000;

        const expired = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            timeExpires: now - 1,
            now,
        });
        expect(
            await VerifyBearerCredential(env.DJIBB_AUTH, expired.token, { now }),
        ).toBeNull();

        const live = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            timeExpires: now + 1000,
            now,
        });
        expect(
            await VerifyBearerCredential(env.DJIBB_AUTH, live.token, { now }),
        ).not.toBeNull();
    });
});

// ─── Hash discipline ─────────────────────────────────────────────────────────

describe('CreateCredential — hash discipline', () => {
    it('persists only SHA-256(raw), never the raw secret', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
        });
        const secret = token.split('.')[1]!;

        const row = await readCredentialRow(credentialId);
        expect(row).not.toBeNull();
        expect(row!.secret_hash).not.toBe(secret);
        expect(row!.secret_hash).not.toContain(secret);
        expect(row!.secret_hash).toBe(await hashSecret(secret));
    });
});

// ─── time_last_used: best-effort + throttled ─────────────────────────────────

// ─── bound_entity_id enforcement: see the `tokenBindsToEntity` block ─────────
// (the binding rule retired `credentialPermitsEntity` for the shared leaf).

// ─── Entity-bound revoke (GH #24) ────────────────────────────────────────────

describe('RevokeEntityBoundCredential', () => {
    const ENTITY = 'l/manager-target-aaaaa';

    async function readRevoked(credentialId: string) {
        const row = await readCredentialRow(credentialId);
        return row!.time_revoked;
    }

    it('revokes a token bound to the given entity', async () => {
        const accountId = await insertAccount();
        const { credentialId } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            boundEntityId: ENTITY,
        });

        const ok = await RevokeEntityBoundCredential(env.DJIBB_AUTH, {
            credentialId,
            entityId: ENTITY,
            now: 1_700_000_000,
        });
        expect(ok).toBe(true);
        expect(await readRevoked(credentialId)).toBe(1_700_000_000);
    });

    it('refuses an unbound (account-wide) token — the owner-only case', async () => {
        const accountId = await insertAccount();
        const { credentialId } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
        });

        const ok = await RevokeEntityBoundCredential(env.DJIBB_AUTH, {
            credentialId,
            entityId: ENTITY,
        });
        expect(ok).toBe(false);
        expect(await readRevoked(credentialId)).toBeNull();
    });

    it('refuses a token bound to a different entity', async () => {
        const accountId = await insertAccount();
        const { credentialId } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            boundEntityId: 'l/some-other-entity-bb',
        });

        const ok = await RevokeEntityBoundCredential(env.DJIBB_AUTH, {
            credentialId,
            entityId: ENTITY,
        });
        expect(ok).toBe(false);
        expect(await readRevoked(credentialId)).toBeNull();
    });

    it('is idempotent — a second revoke matches nothing', async () => {
        const accountId = await insertAccount();
        const { credentialId } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            boundEntityId: ENTITY,
        });

        expect(
            await RevokeEntityBoundCredential(env.DJIBB_AUTH, {
                credentialId,
                entityId: ENTITY,
            }),
        ).toBe(true);
        expect(
            await RevokeEntityBoundCredential(env.DJIBB_AUTH, {
                credentialId,
                entityId: ENTITY,
            }),
        ).toBe(false);
    });
});

describe('VerifyBearerCredential — time_last_used', () => {
    it('schedules a throttled touch via waitUntil, but not on every request', async () => {
        const accountId = await insertAccount();
        const now = 1_700_000_000;
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            now,
        });

        const scheduled: Promise<unknown>[] = [];
        const waitUntil = (p: Promise<unknown>) => scheduled.push(p);

        // First use: time_last_used is NULL → a touch is due.
        await VerifyBearerCredential(env.DJIBB_AUTH, token, { waitUntil, now });
        expect(scheduled).toHaveLength(1);
        await Promise.all(scheduled);
        expect((await readCredentialRow(credentialId))!.time_last_used).toBe(now);

        // Second use within the throttle window → no new touch.
        await VerifyBearerCredential(env.DJIBB_AUTH, token, {
            waitUntil,
            now: now + 60,
        });
        expect(scheduled).toHaveLength(1);

        // Past the throttle window → touch again.
        await VerifyBearerCredential(env.DJIBB_AUTH, token, {
            waitUntil,
            now: now + 10_000,
        });
        expect(scheduled).toHaveLength(2);
    });

    it('skips the touch entirely when no waitUntil is provided', async () => {
        const accountId = await insertAccount();
        const { credentialId, token } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
        });

        const resolved = await VerifyBearerCredential(env.DJIBB_AUTH, token);
        expect(resolved).not.toBeNull();
        expect((await readCredentialRow(credentialId))!.time_last_used).toBeNull();
    });
});

// ─── tokenBindsToEntity (the shared binding leaf, candidate 2) ───────────────

describe('tokenBindsToEntity', () => {
    it('permits an unbound (NULL) token on any entity', () => {
        expect(tokenBindsToEntity(null, 'l/anything')).toBe(true);
    });

    it('permits a bound token on exactly its bound entity', () => {
        expect(tokenBindsToEntity('l/abc', 'l/abc')).toBe(true);
    });

    it('denies a bound token on any other entity', () => {
        expect(tokenBindsToEntity('l/abc', 'l/xyz')).toBe(false);
    });

    it('is prefix-agnostic — one rule across List/Template/Workspace/Account', () => {
        expect(tokenBindsToEntity('w/ws', 'w/ws')).toBe(true);
        expect(tokenBindsToEntity('a/acc', 'l/acc')).toBe(false);
    });
});

// ─── credentialState (the shared liveness leaf, folded candidate 3) ──────────

describe('credentialState', () => {
    const now = 1_000_000;

    it('is active when neither revoked nor expired', () => {
        expect(credentialState({ time_revoked: null, time_expires: null }, now))
            .toBe('active');
        expect(
            credentialState({ time_revoked: null, time_expires: now + 1 }, now),
        ).toBe('active');
    });

    it('is expired when past its window and not revoked', () => {
        expect(
            credentialState({ time_revoked: null, time_expires: now }, now),
        ).toBe('expired');
        expect(
            credentialState({ time_revoked: null, time_expires: now - 1 }, now),
        ).toBe('expired');
    });

    it('is revoked when revoked, even if also expired (revoked beats expired)', () => {
        expect(
            credentialState({ time_revoked: now - 5, time_expires: now - 1 }, now),
        ).toBe('revoked');
        expect(
            credentialState({ time_revoked: now - 5, time_expires: null }, now),
        ).toBe('revoked');
    });
});
