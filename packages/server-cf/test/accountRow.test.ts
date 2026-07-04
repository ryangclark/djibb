/**
 * accountFromRow — the single accounts⋈ join-row → Account mapper
 * (candidate 4). Both GetSessionById (auth/session.ts) and
 * VerifyBearerCredential (auth/credential.ts) translate the same ~12
 * account columns; this is the one place that mapping lives now.
 *
 * Pure (row object in, Account out) — no D1 needed.
 */
import { describe, expect, it } from 'vitest';

import { accountFromRow } from '../src/auth/account-row';

/** A representative join row, using the aliases both SELECTs already emit. */
function row(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        account_id: 'a/abc123',
        display_name: 'Ryan',
        email: 'r@example.com',
        email_verified: 1,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g-1',
        account_time_created: 1_700_000_000,
        account_time_deleted: null,
        account_time_updated: 1_700_000_500,
        user_name: null,
        ...overrides,
    };
}

describe('accountFromRow', () => {
    it('maps the join-row columns to an Account', () => {
        const account = accountFromRow(row());
        expect(account.id).toBe('a/abc123');
        expect(account.display_name).toBe('Ryan');
        expect(account.email).toBe('r@example.com');
        expect(account.provider_name).toBe('google');
    });

    it('converts unix-second columns to Dates (×1000)', () => {
        const account = accountFromRow(row());
        expect(account.time_created).toEqual(new Date(1_700_000_000 * 1000));
        expect(account.time_updated).toEqual(new Date(1_700_000_500 * 1000));
    });

    it('maps a null time_deleted to null, a set one to a Date', () => {
        expect(accountFromRow(row()).time_deleted).toBeNull();
        expect(
            accountFromRow(row({ account_time_deleted: 1_700_000_900 }))
                .time_deleted,
        ).toEqual(new Date(1_700_000_900 * 1000));
    });

    it('JSON-parses the flags column when present', () => {
        const account = accountFromRow(row({ flags: '{"beta":true}' }));
        expect(account.flags).toEqual({ beta: true });
    });
});
