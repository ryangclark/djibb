// @ts-check

import { describe, expect, it } from 'vitest';
import { createUnflushedLedger, resolveEffectiveAccount } from './unflushed.js';

/** In-memory stand-in for `localStorage`. */
function memoryStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ k) => map.get(k) ?? null,
		setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
			map.set(k, v);
		},
		removeItem: (/** @type {string} */ k) => {
			map.delete(k);
		},
		keys: () => [...map.keys()],
		size: () => map.size
	};
}

function setup() {
	const storage = memoryStorage();
	return { storage, ledger: createUnflushedLedger({ storage }) };
}

describe('ledger', () => {
	it('records and retires a claim', () => {
		const { ledger, storage } = setup();
		ledger.mark('l/1', 'acct_a');
		expect(ledger.accountsFor('l/1')).toEqual(['acct_a']);

		ledger.clear('l/1', 'acct_a');
		expect(ledger.accountsFor('l/1')).toEqual([]);
		// The key is removed, not left as an empty array — a ledger that
		// only grows would keep every entity ever edited.
		expect(storage.size()).toBe(0);
	});

	it('is idempotent — marking twice is still one claim', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		ledger.mark('l/1', 'acct_a');
		expect(ledger.accountsFor('l/1')).toEqual(['acct_a']);
	});

	it('keeps other accounts claims when one is retired', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		ledger.mark('l/1', 'acct_b');

		ledger.clear('l/1', 'acct_a');

		expect(ledger.accountsFor('l/1')).toEqual(['acct_b']);
	});

	it('lists every entity an account has unflushed work for', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		ledger.mark('t/2', 'acct_a');
		ledger.mark('l/3', 'acct_b');

		expect(ledger.entitiesFor('acct_a').sort()).toEqual(['l/1', 't/2']);
		expect(ledger.entitiesFor('acct_b')).toEqual(['l/3']);
	});

	it('treats a corrupt entry as absent rather than throwing', () => {
		// A wedged ledger entry must never be able to block a list from
		// loading — the entity is what matters, the claim is bookkeeping.
		const { ledger, storage } = setup();
		storage.setItem('djibb.unflushed.l/1', '{not json');
		expect(ledger.accountsFor('l/1')).toEqual([]);
	});
});

describe('resolveEffectiveAccount', () => {
	it('a live session always wins', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_stale');
		expect(
			resolveEffectiveAccount({
				accountId: 'acct_live',
				entityId: 'l/1',
				ledger
			})
		).toBe('acct_live');
	});

	it('a null session with no claim is genuinely anonymous', () => {
		// The ordinary never-signed-in path. Nothing about #43 may change
		// behaviour for a user who has no unflushed work.
		const { ledger } = setup();
		expect(
			resolveEffectiveAccount({ accountId: null, entityId: 'l/1', ledger })
		).toBe(null);
	});

	it('a null session with a claim keeps acting as the claimant', () => {
		// This is the whole fix: the expired-session reload resolves back
		// to the store the queued mutations actually live in.
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		expect(
			resolveEffectiveAccount({ accountId: null, entityId: 'l/1', ledger })
		).toBe('acct_a');
	});

	it('a claim on another entity does not leak', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		expect(
			resolveEffectiveAccount({ accountId: null, entityId: 'l/2', ledger })
		).toBe(null);
	});

	it('picks the most recent claimant when several accounts are stuck', () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		ledger.mark('l/1', 'acct_b');

		expect(
			resolveEffectiveAccount({ accountId: null, entityId: 'l/1', ledger })
		).toBe('acct_b');

		// ...and once that one drains, the next load picks up the other.
		// It converges without ever dropping work, which is the property
		// that matters.
		ledger.clear('l/1', 'acct_b');
		expect(
			resolveEffectiveAccount({ accountId: null, entityId: 'l/1', ledger })
		).toBe('acct_a');
	});
});
