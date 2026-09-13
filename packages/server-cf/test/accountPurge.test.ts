/**
 * Account (identity) deletion — Phase 2 (GH #64): the scheduled hard
 * purge of PII + the owned-entity ownership-relinquish cascade + the
 * within-grace restore path. The irreversible back half Phase 1
 * (`accountDeletion.test.ts`) deferred behind the `time_deleted`
 * tombstone.
 *
 * Layers, mirroring the plan:
 *   1. Pure decision helpers (`relinquishOwnership` / `pickSuccessorAccountId`)
 *      — seniority, orphaning, departing-drop, projection-lag no-op.
 *   2. `relinquishOwnershipOnPurge` DO mutator — the system push wires the
 *      pure decision through `_handlePush` against real DO rules.
 *   3. `PurgeTombstonedAccounts` D1 sweep — select-by-grace, scrub-in-place,
 *      `time_purged` idempotency, orphan-session reap, and end-to-end with a
 *      real owned entity (driver + cascade + sweep together).
 *   4. `RestoreTombstonedAccountByEmail` — un-tombstone within grace; null
 *      past grace / already purged.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import {
    ACCOUNT_PURGE_GRACE_SECONDS,
    PurgeTombstonedAccounts,
    RestoreTombstonedAccountByEmail,
} from '../src/auth/d1';
import {
    pickSuccessorAccountId,
    relinquishOwnership,
} from '@djibb/protocol/list/mutators/_shared';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import { IdTypes, newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const NOW = 1_700_000_000;
const PAST_GRACE = NOW - ACCOUNT_PURGE_GRACE_SECONDS - 1;
const WITHIN_GRACE = NOW - 60; // deleted a minute ago

// ─── Pure helpers ──────────────────────────────────────────────────────────

function rules(
    accounts: Record<string, string>,
    default_role: AuthorizationRules['default_role'] = 'restricted',
): AuthorizationRules {
    return {
        authorized_accounts: Object.fromEntries(
            Object.entries(accounts).map(([id, role]) => [id, { role } as any]),
        ),
        default_role,
        set_by: 'user',
    };
}

describe('pickSuccessorAccountId', () => {
    it('prefers admin over editor over checker', () => {
        expect(
            pickSuccessorAccountId(
                rules({ ed: 'editor', ad: 'admin', ck: 'checker' }),
            ),
        ).toBe('ad');
        expect(
            pickSuccessorAccountId(rules({ ed: 'editor', ck: 'checker' })),
        ).toBe('ed');
    });

    it('breaks a seniority tie on the lowest account id (deterministic)', () => {
        expect(
            pickSuccessorAccountId(rules({ z_admin: 'admin', a_admin: 'admin' })),
        ).toBe('a_admin');
    });

    it('returns null when only read-only / non-edit roles remain', () => {
        expect(
            pickSuccessorAccountId(
                rules({ v: 'viewer', s: 'submitter', r: 'restricted' }),
            ),
        ).toBeNull();
        expect(pickSuccessorAccountId(rules({}))).toBeNull();
    });
});

describe('relinquishOwnership', () => {
    it('force-transfers to the most-senior member and drops the departing owner', () => {
        const out = relinquishOwnership(
            rules({ owner: 'owner', ad: 'admin', ed: 'editor' }),
            'owner',
        );
        expect(out.authorized_accounts.owner).toBeUndefined();
        expect(out.authorized_accounts.ad?.role).toBe('owner');
        expect(out.authorized_accounts.ed?.role).toBe('editor');
    });

    it('orphans to ownerless when no eligible member remains', () => {
        const out = relinquishOwnership(
            rules({ owner: 'owner', v: 'viewer' }, 'restricted'),
            'owner',
        );
        expect(out.authorized_accounts.owner).toBeUndefined();
        expect(out.default_role).toBe('ownerless');
        // No account is left holding owner.
        expect(
            Object.values(out.authorized_accounts).some(a => a.role === 'owner'),
        ).toBe(false);
    });

    it('just removes a non-owner member without touching ownership', () => {
        const out = relinquishOwnership(
            rules({ owner: 'owner', ed: 'editor' }),
            'ed',
        );
        expect(out.authorized_accounts.ed).toBeUndefined();
        expect(out.authorized_accounts.owner?.role).toBe('owner');
        expect(out.default_role).toBe('restricted');
    });

    it('is a no-op (same reference) when the account is not a member', () => {
        const input = rules({ owner: 'owner' });
        expect(relinquishOwnership(input, 'stranger')).toBe(input);
    });
});

// ─── DO round-trip helpers (mirror terminalMarker.test.ts) ───────────────────

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makePush<TBody extends Record<string, unknown>>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
    accountId = null,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
    accountId?: string | null;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: mutationId,
                name,
                timestamp: Date.now(),
                args: {
                    accountId,
                    timestamp_client: new Date().toISOString(),
                    ...body,
                } as any,
            },
        ],
    };
}

function makeInitListPush(listId: string, accountId: string): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID: `cg_${accountId}`,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: `c_${accountId}`,
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                } as any,
            },
        ],
    };
}

async function readRules(
    stub: DurableObjectStub<DjibbList>,
    listId: string,
): Promise<AuthorizationRules> {
    return runInDurableObject(stub, async (_i, state) => {
        const row = state.storage.sql
            .exec(
                `SELECT authorization_rules FROM list_elements WHERE id = ?;`,
                listId,
            )
            .one();
        return JSON.parse(row.authorization_rules as string) as AuthorizationRules;
    });
}

/** Init a list owned by `ownerA`, then add `members` (id → role) via
 *  changeMemberRole. Returns stub + ids. */
async function initOwnedList(
    suffix: string,
    ownerA: string,
    members: Record<string, string> = {},
) {
    const { listId, stub } = getListStub(suffix);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerA } as any],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush(listId, ownerA),
    });
    let mutationId = 2;
    for (const [targetAccountId, role] of Object.entries(members)) {
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID: `cg_${ownerA}`,
                clientID: `c_${ownerA}`,
                name: 'changeMemberRole',
                mutationId: mutationId++,
                accountId: ownerA,
                body: { listId, targetAccountId, role },
            }),
        });
    }
    return { listId, stub };
}

/** Drive `relinquishOwnershipOnPurge` as the purge worker does. */
async function pushRelinquish(
    stub: DurableObjectStub<DjibbList>,
    listId: string,
    departingAccountId: string,
) {
    return stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'system',
        listId,
        pushRequest: makePush({
            clientGroupID: `cg_purge:${departingAccountId}`,
            clientID: `purge:${departingAccountId}:${listId}`,
            name: 'relinquishOwnershipOnPurge',
            mutationId: 1,
            body: { listId, departingAccountId },
        }),
    });
}

describe('relinquishOwnershipOnPurge (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('promotes the senior member to owner and drops the departing owner', async () => {
        const ownerA = newId('account');
        const editorB = newId('account');
        const { listId, stub } = await initOwnedList('rel_transfer', ownerA, {
            [editorB]: 'editor',
        });

        const res = await pushRelinquish(stub, listId, ownerA);
        expect(res.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]).toBeUndefined();
        expect(after.authorized_accounts[editorB]?.role).toBe('owner');
    });

    it('orphans a sole-owned entity to ownerless', async () => {
        const ownerA = newId('account');
        const { listId, stub } = await initOwnedList('rel_orphan', ownerA);

        const res = await pushRelinquish(stub, listId, ownerA);
        expect(res.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]).toBeUndefined();
        expect(after.default_role).toBe('ownerless');
    });

    it('rewrites rules even for a trashed (soft-deleted) entity (GH #64 review #1)', async () => {
        const ownerA = newId('account');
        const editorB = newId('account');
        const { listId, stub } = await initOwnedList('rel_trashed', ownerA, {
            [editorB]: 'editor',
        });
        // Trash the entity directly, then relinquish: the live-only
        // read/write would no-op/throw and leave ownerA dangling.
        await runInDurableObject(stub, (_i, state) => {
            state.storage.sql.exec(
                `UPDATE list_elements SET time_deleted = ? WHERE id = ?;`,
                Date.now(),
                listId,
            );
        });

        const res = await pushRelinquish(stub, listId, ownerA);
        expect(res.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]).toBeUndefined();
        expect(after.authorized_accounts[editorB]?.role).toBe('owner');
    });

    it('drops a non-owner member without changing ownership (GH #64 review #4)', async () => {
        const ownerA = newId('account');
        const editorB = newId('account');
        const { listId, stub } = await initOwnedList('rel_nonowner', ownerA, {
            [editorB]: 'editor',
        });

        // editorB (not the owner) is the departing account.
        const res = await pushRelinquish(stub, listId, editorB);
        expect(res.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[editorB]).toBeUndefined();
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
    });
});

// ─── D1 sweep ────────────────────────────────────────────────────────────────

async function insertAccount(overrides: {
    id?: string;
    email?: string | null;
    time_deleted?: number | null;
    time_purged?: number | null;
}): Promise<string> {
    const id = overrides.id ?? newId('account');
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO accounts (
            id, display_name, email, email_verified, flags, image,
            provider_name, provider_client_id, time_created, time_updated,
            time_deleted, time_purged, user_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
        .bind(
            id,
            'Test User',
            overrides.email === undefined
                ? `t-${Math.random().toString(36).slice(2)}@example.com`
                : overrides.email,
            1,
            null,
            'https://img.example/x.png',
            'djibb',
            overrides.email ?? `pc-${id}`,
            NOW,
            NOW,
            overrides.time_deleted ?? null,
            overrides.time_purged ?? null,
            'testuser',
        )
        .run();
    return id;
}

async function accountRow(id: string) {
    return env.DJIBB_AUTH.prepare('SELECT * FROM accounts WHERE id = ?')
        .bind(id)
        .first<Record<string, any>>();
}

async function seedMembership(accountId: string, entityId: string, role: string) {
    await env.DJIBB_AUTH.prepare(
        `INSERT OR REPLACE INTO entity_memberships (account_id, entity_id, role, time_updated)
         VALUES (?, ?, ?, ?)`,
    )
        .bind(accountId, entityId, role, NOW)
        .run();
}

async function seedEntity(id: string, type: 'list' | 'template') {
    await env.DJIBB_AUTH.prepare(
        `INSERT OR IGNORE INTO workspace_entities (
            id, type, name, slug, workspace_id, authorization_rules,
            time_created, time_updated, time_deleted
         ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
        .bind(id, type, 'seeded', id.slice(2), null, NOW, NOW, null)
        .run();
}

async function membershipCount(accountId: string): Promise<number> {
    const row = await env.DJIBB_AUTH.prepare(
        'SELECT COUNT(*) AS n FROM entity_memberships WHERE account_id = ?',
    )
        .bind(accountId)
        .first<{ n: number }>();
    return row?.n ?? 0;
}

describe('PurgeTombstonedAccounts', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('scrubs PII in place and stamps time_purged for a past-grace tombstone', async () => {
        const id = await insertAccount({
            email: 'gone@example.com',
            time_deleted: PAST_GRACE,
        });
        // A non-owner membership row (shared-with) should be cleaned too.
        await seedEntity('l/shared__aaaaaaaaaaa', 'list');
        await seedMembership(id, 'l/shared__aaaaaaaaaaa', 'editor');

        const res = await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now: NOW,
        });
        expect(res.purged).toBe(1);

        const row = await accountRow(id);
        // Nullable PII → NULL; NOT NULL PII → emptied to ''.
        expect(row!.email).toBeNull();
        expect(row!.image).toBeNull();
        expect(row!.user_name).toBeNull();
        expect(row!.display_name).toBe('');
        expect(row!.provider_client_id).toBe('');
        expect(row!.time_purged).toBe(NOW);
        // Tombstone shell kept: id + time_deleted survive.
        expect(row!.id).toBe(id);
        expect(row!.time_deleted).toBe(PAST_GRACE);
        expect(await membershipCount(id)).toBe(0);
    });

    it('leaves a within-grace tombstone untouched', async () => {
        const id = await insertAccount({
            email: 'recent@example.com',
            time_deleted: WITHIN_GRACE,
        });
        const res = await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now: NOW,
        });
        expect(res.scanned).toBe(0);
        const row = await accountRow(id);
        expect(row!.email).toBe('recent@example.com');
        expect(row!.time_purged).toBeNull();
    });

    it('does not re-select an already-purged account', async () => {
        const id = await insertAccount({
            email: null,
            time_deleted: PAST_GRACE,
            time_purged: NOW - 100,
        });
        const res = await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now: NOW,
        });
        expect(res.scanned).toBe(0);
        // time_purged unchanged (not re-stamped).
        expect((await accountRow(id))!.time_purged).toBe(NOW - 100);
    });

    it('reaps a zero-account orphan session left by Phase 1', async () => {
        // The reap only runs on a tick that actually purged something, so
        // give the sweep a past-grace account to purge.
        await insertAccount({ email: 'p@example.com', time_deleted: PAST_GRACE });
        const orphanId = newId('session');
        await env.DJIBB_AUTH.prepare(
            `INSERT INTO sessions (id, time_created, time_expires, ip_country)
             VALUES (?, ?, ?, '')`,
        )
            .bind(orphanId, NOW, NOW + 999999)
            .run();

        await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now: NOW,
        });

        const row = await env.DJIBB_AUTH.prepare(
            'SELECT id FROM sessions WHERE id = ?',
        )
            .bind(orphanId)
            .first();
        expect(row).toBeNull();
    });

    it('relinquishes an owned entity to a member, then scrubs (end-to-end)', async () => {
        const ownerA = await insertAccount({
            email: 'owner@example.com',
            time_deleted: PAST_GRACE,
        });
        const editorB = newId('account');
        const { listId, stub } = await initOwnedList('purge_owned', ownerA, {
            [editorB]: 'editor',
        });
        // Guarantee the cascade's owned-entity lookup finds it regardless of
        // whether the DO's post-commit projection ran in the harness.
        await seedEntity(listId, 'list');
        await seedMembership(ownerA, listId, 'owner');

        const res = await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now: NOW,
        });
        expect(res.entitiesRelinquished).toBeGreaterThanOrEqual(1);
        expect(res.purged).toBe(1);

        // Authoritative: ownership moved on the DO itself.
        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]).toBeUndefined();
        expect(after.authorized_accounts[editorB]?.role).toBe('owner');

        // Account scrubbed + its membership rows gone.
        expect((await accountRow(ownerA))!.email).toBeNull();
        expect(await membershipCount(ownerA)).toBe(0);
    });
});

// ─── Restore ─────────────────────────────────────────────────────────────────

describe('RestoreTombstonedAccountByEmail', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('un-tombstones a within-grace account and returns it', async () => {
        const id = await insertAccount({
            email: 'restore@example.com',
            time_deleted: WITHIN_GRACE,
        });
        const restored = await RestoreTombstonedAccountByEmail(env.DJIBB_AUTH, {
            email: 'restore@example.com',
            now: NOW,
            graceSeconds: ACCOUNT_PURGE_GRACE_SECONDS,
        });
        expect(restored?.id).toBe(id);
        expect((await accountRow(id))!.time_deleted).toBeNull();
    });

    it('returns null past the grace window (leaves the tombstone for purge)', async () => {
        const id = await insertAccount({
            email: 'old@example.com',
            time_deleted: PAST_GRACE,
        });
        const restored = await RestoreTombstonedAccountByEmail(env.DJIBB_AUTH, {
            email: 'old@example.com',
            now: NOW,
            graceSeconds: ACCOUNT_PURGE_GRACE_SECONDS,
        });
        expect(restored).toBeNull();
        expect((await accountRow(id))!.time_deleted).toBe(PAST_GRACE);
    });

    it('returns null for an already-purged account', async () => {
        await insertAccount({
            email: 'purged@example.com',
            time_deleted: WITHIN_GRACE,
            time_purged: NOW - 10,
        });
        const restored = await RestoreTombstonedAccountByEmail(env.DJIBB_AUTH, {
            email: 'purged@example.com',
            now: NOW,
            graceSeconds: ACCOUNT_PURGE_GRACE_SECONDS,
        });
        expect(restored).toBeNull();
    });
});
