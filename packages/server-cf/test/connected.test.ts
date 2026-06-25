/**
 * Connected-clients union read (ADR 0022 §6, GH #23).
 *
 * The "what's connected" surface unions two D1-native principal sources —
 * interactive `sessions` and issued `issued_credentials` tokens. There is no
 * ADR 0003 projection here: neither source originates in a Durable Object, so
 * D1 is already the system of record (see `src/auth/connected.ts`). These
 * tests cover the union read's load-bearing behavior:
 *
 *   1. Unions sessions + tokens for an Account, shaped to the #19 field set
 *   2. Multi-account scope (the entity-roster composition case)
 *   3. State classification: active vs. expired vs. revoked
 *   4. History is returned, not filtered (caller partitions by state)
 *   5. Entity narrowing drops tokens bound to a *different* entity, keeps
 *      unbound tokens and all sessions
 *   6. Empty scope short-circuits
 */

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    ListConnectedClients,
    partitionConnectedClients,
} from '../src/auth/connected';
import { CreateCredential } from '../src/auth/credential';
import { newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => {
    await ensureD1Schema();
});
beforeEach(async () => {
    await resetWorkspaceData();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function insertAccount(id = newId('account')): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, provider_name,
            provider_client_id, time_created, time_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id,
            'Test User',
            `t-${Math.random().toString(36).slice(2)}@example.com`,
            1,
            'google',
            'g-' + Math.random().toString(36).slice(2),
            now,
            now,
        )
        .run();
    return id;
}

/** Insert a `sessions` row and link it to `accountId` via `AccountSession`. */
async function insertSession(
    accountId: string,
    { timeExpires, timeCreated }: { timeExpires: number; timeCreated?: number },
): Promise<string> {
    const id = newId('session');
    await env.DJIBB_AUTH.batch([
        env.DJIBB_AUTH.prepare(
            `INSERT INTO sessions (id, ip_country, time_created, time_expires)
             VALUES (?, ?, ?, ?);`,
        ).bind(id, 'US', timeCreated ?? Math.floor(Date.now() / 1000), timeExpires),
        env.DJIBB_AUTH.prepare(
            `INSERT INTO AccountSession (account_id, session_id) VALUES (?, ?);`,
        ).bind(accountId, id),
    ]);
    return id;
}

const NOW = 1_700_000_000;

// ─── Union shape ─────────────────────────────────────────────────────────────

describe('ListConnectedClients — union shape', () => {
    it('unions sessions and tokens for an account, shaped to the #19 fields', async () => {
        const accountId = await insertAccount();
        const sessionId = await insertSession(accountId, {
            timeExpires: NOW + 1000,
            timeCreated: NOW - 50,
        });
        const { credentialId } = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: "Ryan's laptop CLI",
            now: NOW,
        });

        const clients = await ListConnectedClients(env.DJIBB_AUTH, {
            accountIds: [accountId],
            now: NOW,
        });

        const session = clients.find(c => c.kind === 'session')!;
        const token = clients.find(c => c.kind === 'token')!;

        // Session: no label / binding / last-used; active inside its window.
        expect(session.id).toBe(sessionId);
        expect(session.account_id).toBe(accountId);
        expect(session.label).toBeNull();
        expect(session.bound_entity_id).toBeNull();
        expect(session.time_last_used).toBeNull();
        expect(session.state).toBe('active');

        // Token: carries label; unbound; non-expiring; active.
        expect(token.id).toBe(credentialId);
        expect(token.account_id).toBe(accountId);
        expect(token.label).toBe("Ryan's laptop CLI");
        expect(token.bound_entity_id).toBeNull();
        expect(token.time_expires).toBeNull();
        expect(token.state).toBe('active');
    });

    it('scopes across multiple accounts (the entity-roster case)', async () => {
        const a1 = await insertAccount();
        const a2 = await insertAccount();
        const a3 = await insertAccount();
        await insertSession(a1, { timeExpires: NOW + 1000 });
        await CreateCredential(env.DJIBB_AUTH, { accountId: a2, now: NOW });

        const clients = await ListConnectedClients(env.DJIBB_AUTH, {
            accountIds: [a1, a2],
            now: NOW,
        });

        const accounts = new Set(clients.map(c => c.account_id));
        expect(accounts).toEqual(new Set([a1, a2]));
        // a3 wasn't in scope → none of its (absent) principals appear.
        expect(clients.some(c => c.account_id === a3)).toBe(false);
    });

    it('returns [] for an empty account scope without touching D1', async () => {
        expect(
            await ListConnectedClients(env.DJIBB_AUTH, { accountIds: [], now: NOW }),
        ).toEqual([]);
    });
});

// ─── State classification + history ──────────────────────────────────────────

describe('ListConnectedClients — state', () => {
    it('classifies active / expired / revoked and returns history rows', async () => {
        const accountId = await insertAccount();

        // Expired session (past its window) + active session.
        await insertSession(accountId, { timeExpires: NOW - 1 });
        await insertSession(accountId, { timeExpires: NOW + 1000 });

        // Active, expired, and revoked tokens.
        await CreateCredential(env.DJIBB_AUTH, { accountId, label: 'live', now: NOW });
        await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: 'stale',
            timeExpires: NOW - 1,
            now: NOW,
        });
        const revoked = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: 'rotated',
            now: NOW,
        });
        await env.DJIBB_AUTH.prepare(
            'UPDATE issued_credentials SET time_revoked = ? WHERE credential_id = ?',
        )
            .bind(NOW - 10, revoked.credentialId)
            .run();

        const clients = await ListConnectedClients(env.DJIBB_AUTH, {
            accountIds: [accountId],
            now: NOW,
        });

        const states = clients.map(c => c.state).sort();
        // 2 sessions (active, expired) + 3 tokens (active, expired, revoked).
        expect(states).toEqual(
            ['active', 'active', 'expired', 'expired', 'revoked'].sort(),
        );

        const { active, history } = partitionConnectedClients(clients);
        expect(active).toHaveLength(2); // one session + one token
        expect(history).toHaveLength(3); // expired session, expired + revoked token
        expect(history.every(c => c.state !== 'active')).toBe(true);
    });
});

// ─── Entity narrowing ────────────────────────────────────────────────────────

describe('ListConnectedClients — entityId narrowing', () => {
    it('drops tokens bound elsewhere; keeps unbound tokens and all sessions', async () => {
        const accountId = await insertAccount();
        const here = newId('list');
        const elsewhere = newId('list');

        await insertSession(accountId, { timeExpires: NOW + 1000 });
        const unbound = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: 'account-wide',
            now: NOW,
        });
        const boundHere = await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: 'this entity',
            boundEntityId: here,
            now: NOW,
        });
        await CreateCredential(env.DJIBB_AUTH, {
            accountId,
            label: 'other entity',
            boundEntityId: elsewhere,
            now: NOW,
        });

        const clients = await ListConnectedClients(env.DJIBB_AUTH, {
            accountIds: [accountId],
            entityId: here,
            now: NOW,
        });

        const tokenIds = clients
            .filter(c => c.kind === 'token')
            .map(c => c.id)
            .sort();
        expect(tokenIds).toEqual([unbound.credentialId, boundHere.credentialId].sort());
        // The session is account-wide → always present despite entityId.
        expect(clients.some(c => c.kind === 'session')).toBe(true);
    });
});
