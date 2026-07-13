// @ts-check

import { describe, expect, it, vi } from 'vitest';
import {
	createUnflushedLedger,
	discardUnflushed,
	resolveEffectiveAccount,
	UnflushedDiscardError
} from './unflushed.js';

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

describe('markVersion', () => {
	it('advances on every mark, even a redundant one', () => {
		// The sync tracker compares this across an await to decide whether
		// its pending-count read is stale. A repeat mark writes nothing to
		// storage but still means "work was claimed just now", so it must
		// still move the counter — otherwise the tracker could retire a
		// claim for a mutation staked during its read.
		const { ledger } = setup();
		const v0 = ledger.markVersion();

		ledger.mark('l/1', 'acct_a');
		const v1 = ledger.markVersion();
		expect(v1).toBeGreaterThan(v0);

		ledger.mark('l/1', 'acct_a'); // same claim again
		expect(ledger.markVersion()).toBeGreaterThan(v1);
	});
});

describe('discardUnflushed', () => {
	it('drops the store, then retires the claim', async () => {
		// Order matters: retiring the claim first would leave the mutations
		// rotting in a store nothing will ever open again if the drop then
		// failed.
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');

		/** @type {string[]} */
		const dropped = [];
		const result = await discardUnflushed({
			ledger,
			accountId: 'acct_a',
			dropStore: async (dbName) => {
				// The claim must still be there while the store is being dropped.
				expect(ledger.accountsFor('l/1')).toContain('acct_a');
				dropped.push(dbName);
			}
		});

		expect(result).toEqual(['l/1']);
		expect(ledger.accountsFor('l/1')).toEqual([]);
		// Derived from the same storeName + SCHEMA_VERSION the client is
		// built with. Pinned because a drift here means "remove all unsaved
		// changes" silently misses the store it was supposed to destroy —
		// the user is told the work is gone while it quietly isn't.
		// (`rep:<name>:<format>:<schemaVersion>` is Replicache's own
		// makeIDBName shape; `acct_a:l/1` is our storeName, `1` our schema.)
		expect(dropped).toEqual(['rep:acct_a:l/1:7:1']);
	});

	it('leaves other accounts stores alone', async () => {
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');
		ledger.mark('l/2', 'acct_b');

		const dropStore = vi.fn(async () => {});
		await discardUnflushed({ ledger, accountId: 'acct_a', dropStore });

		expect(dropStore).toHaveBeenCalledTimes(1);
		expect(ledger.accountsFor('l/2')).toEqual(['acct_b']);
	});

	it('times out rather than hanging when a store will not close', async () => {
		// `indexedDB.deleteDatabase` BLOCKS (never fires success) while
		// another tab holds the database open — it does not reject. Awaiting
		// it bare would hang forever, and by then the user is already signed
		// out, so they'd be stuck on a spinner with nothing to catch.
		const { ledger } = setup();
		ledger.mark('l/1', 'acct_a');

		const err = await discardUnflushed({
			ledger,
			accountId: 'acct_a',
			timeoutMs: 10,
			dropStore: () => new Promise(() => {}) // never settles, like a blocked delete
		}).catch((e) => e);

		expect(err).toBeInstanceOf(UnflushedDiscardError);
		expect(err.blocked).toEqual(['l/1']);
		// The work is still there, so the claim must be too — saying
		// otherwise would strand it silently.
		expect(ledger.accountsFor('l/1')).toEqual(['acct_a']);
	});

	it('reports partial success rather than failing silently', async () => {
		const { ledger } = setup();
		ledger.mark('l/ok', 'acct_a');
		ledger.mark('l/stuck', 'acct_a');

		const err = await discardUnflushed({
			ledger,
			accountId: 'acct_a',
			timeoutMs: 10,
			dropStore: (dbName) =>
				dbName.includes('l/stuck')
					? new Promise(() => {})
					: Promise.resolve()
		}).catch((e) => e);

		expect(err).toBeInstanceOf(UnflushedDiscardError);
		expect(err.dropped).toEqual(['l/ok']);
		expect(err.blocked).toEqual(['l/stuck']);
		expect(ledger.accountsFor('l/ok')).toEqual([]);
		expect(ledger.accountsFor('l/stuck')).toEqual(['acct_a']);
	});
});
