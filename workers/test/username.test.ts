import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import {
    GetAccountByUsername,
    SetAccountUsername,
    assertUsernameFormat,
} from '../src/account/username';
import type { Account } from '@djibb/protocol/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
        display_name: 'Test User',
        email: 'test@example.com',
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

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('username format', () => {
    it('accepts valid usernames', () => {
        expect(() => assertUsernameFormat('alice')).not.toThrow();
        expect(() => assertUsernameFormat('a-b_c123')).not.toThrow();
    });

    it('rejects bad formats', () => {
        expect(() => assertUsernameFormat('1abc')).toThrow();
        expect(() => assertUsernameFormat('ab')).toThrow();
        expect(() => assertUsernameFormat('Has Caps')).toThrow();
        expect(() => assertUsernameFormat('toolong-' + 'x'.repeat(50))).toThrow();
    });

    it('rejects reserved usernames', () => {
        expect(() => assertUsernameFormat('admin')).toThrow(/reserved/);
        expect(() => assertUsernameFormat('settings')).toThrow(/reserved/);
        expect(() => assertUsernameFormat('you')).toThrow(/reserved/);
    });
});

describe('SetAccountUsername + GetAccountByUsername', () => {
    it('claims a username and looks it up', async () => {
        const account = await CreateAccount(env, makeAccount());
        await SetAccountUsername(env.DJIBB_AUTH, account.id, 'alice');
        const found = await GetAccountByUsername(env.DJIBB_AUTH, 'alice');
        expect(found?.id).toBe(account.id);
    });

    it('lookup is case-insensitive', async () => {
        const account = await CreateAccount(env, makeAccount());
        await SetAccountUsername(env.DJIBB_AUTH, account.id, 'BoB');
        const a = await GetAccountByUsername(env.DJIBB_AUTH, 'bob');
        const b = await GetAccountByUsername(env.DJIBB_AUTH, 'BOB');
        expect(a?.id).toBe(account.id);
        expect(b?.id).toBe(account.id);
    });

    it('blocks duplicate (case-insensitive) claims', async () => {
        const a1 = await CreateAccount(env, makeAccount());
        const a2 = await CreateAccount(env, makeAccount());
        await SetAccountUsername(env.DJIBB_AUTH, a1.id, 'carol');
        await expect(
            SetAccountUsername(env.DJIBB_AUTH, a2.id, 'CAROL')
        ).rejects.toThrow(/taken/i);
    });
});
