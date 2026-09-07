// @ts-check

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePuller, makePusher, storeName, wrapMutators } from './replicache.js';
import { bearerToken, sessionCookie } from './transport.js';

/**
 * Records the order of everything that happens, because ordering — not
 * the presence of the mark — is what this file is really testing.
 */
/**
 * @param {{ accountId?: string | null, listId?: string, withLedger?: boolean }} [opts]
 */
function setup({ accountId = 'a/1', listId = 'l/1', withLedger = true } = {}) {
	/** @type {string[]} */
	const events = [];

	const ledger = {
		mark: vi.fn((entityId, acct) => {
			events.push(`mark:${entityId}:${acct}`);
		}),
		// Told about the mutation's promise so it can hold the claim
		// un-retirable until the local write lands.
		trackMutation: vi.fn((/** @type {Promise<unknown>} */ settled) => {
			events.push('track');
			return settled;
		})
	};

	const rawMutate = {
		setName: vi.fn((args) => {
			events.push('mutate:setName');
			return Promise.resolve(args);
		})
	};

	const mutate = wrapMutators(rawMutate, {
		accountId,
		listId,
		ledger: withLedger ? /** @type {any} */ (ledger) : undefined
	});

	return { events, ledger, rawMutate, mutate };
}

describe('wrapMutators — envelope', () => {
	it('injects the account and a client timestamp', async () => {
		const { rawMutate, mutate } = setup();
		await mutate.setName({ name: 'x' });

		const args = rawMutate.setName.mock.calls[0]?.[0];
		expect(args?.name).toBe('x');
		expect(args?.accountId).toBe('a/1');
		expect(args?.timestamp_client).toBeInstanceOf(Date);
	});
});

describe('wrapMutators — unflushed-work claim (GH #43)', () => {
	it('stamps the claim BEFORE handing the mutation to Replicache', async () => {
		// The load-bearing ordering of the whole design. Marking after the
		// mutate would leave a window in which the mutation is durable but
		// unclaimed — a tab closed there strands it forever, which is the
		// original bug. Over-claiming is recoverable; under-claiming is not.
		const { events, mutate } = setup();
		await mutate.setName({ name: 'x' });

		// The claim is staked before Replicache is told anything, and only
		// then is the in-flight promise handed over.
		expect(events).toEqual(['mark:l/1:a/1', 'mutate:setName', 'track']);
	});

	it('marks synchronously — not in a promise callback', () => {
		// Deliberately does not await. The mark must already be durable by
		// the time `mutate` returns, or a tab dying on the same turn could
		// still lose the claim.
		const { ledger, mutate } = setup();
		void mutate.setName({ name: 'x' });

		expect(ledger.mark).toHaveBeenCalledWith('l/1', 'a/1');
	});

	it('does not claim anonymous work', async () => {
		// Nobody to recover it for, so there is nothing to claim.
		const { ledger, rawMutate, mutate } = setup({ accountId: null });
		await mutate.setName({ name: 'x' });

		expect(ledger.mark).not.toHaveBeenCalled();
		expect(ledger.trackMutation).not.toHaveBeenCalled();
		expect(rawMutate.setName).toHaveBeenCalled();
	});

	it('holds the claim un-retirable until the write settles', async () => {
		// The mutation is claimed synchronously but persisted async. In that
		// gap the queue does not yet contain it, so an empty-queue read must
		// not be allowed to retire the claim — the ledger needs the promise
		// to know the window is still open.
		const { ledger, mutate } = setup();
		void mutate.setName({ name: 'x' });

		expect(ledger.trackMutation).toHaveBeenCalledTimes(1);
		expect(ledger.trackMutation.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
	});

	it('still mutates when no ledger is wired up', async () => {
		// The ledger is optional (other clients may not have storage), and
		// its absence must never break mutating.
		const { rawMutate, mutate } = setup({ withLedger: false });
		await mutate.setName({ name: 'x' });

		expect(rawMutate.setName).toHaveBeenCalled();
	});
});

describe('makePusher / makePuller — credential presentation (ADR 0024 item 3)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Stub `fetch` and return the recorded init of the single call. */
	function stubFetch(status = 200, body = '{}') {
		const fetchMock = vi.fn(
			async (/** @type {any} */ _url, /** @type {any} */ _init) =>
				new Response(body, {
					status,
					headers: { 'Content-Type': 'application/json' }
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	it('sends the session cookie by default (unchanged pre-Bearer behavior)', async () => {
		const fetchMock = stubFetch();
		await makePusher('https://api.example/list/push', sessionCookie())(
			/** @type {any} */ ({}),
			'req-1'
		);
		const init = /** @type {any} */ (fetchMock.mock.calls[0]?.[1]);
		expect(init?.credentials).toBe('include');
		// No Authorization header on the cookie path.
		expect(init?.headers).not.toHaveProperty('Authorization');
		// Protocol headers are always present.
		expect(init?.headers).toMatchObject({
			'Content-Type': 'application/json',
			'X-Replicache-RequestID': 'req-1'
		});
	});

	it('carries a Bearer token + Origin for an off-domain client', async () => {
		const fetchMock = stubFetch();
		const credential = bearerToken('tok-123', { origin: 'https://client.example' });
		await makePuller('https://api.example/list/pull', credential)(
			/** @type {any} */ ({}),
			'req-2'
		);
		const init = /** @type {any} */ (fetchMock.mock.calls[0]?.[1]);
		// Bearer clients omit ambient credentials — the token is the identity.
		expect(init?.credentials).toBe('omit');
		expect(init?.headers).toMatchObject({
			Authorization: 'Bearer tok-123',
			Origin: 'https://client.example',
			'Content-Type': 'application/json',
			'X-Replicache-RequestID': 'req-2'
		});
	});

	it('falls back to include when a hand-rolled credential omits credentials', async () => {
		// `Credential.credentials` is optional on the type. Left undefined,
		// fetch would default to 'same-origin' and silently drop cookies on
		// these cross-origin requests — the exact failure the custom
		// pusher/puller exists to prevent. The fallback must be 'include'.
		const fetchMock = stubFetch();
		await makePusher('https://api.example/list/push', /** @type {any} */ ({
			headers: { 'X-Anything': 'y' }
		}))(/** @type {any} */ ({}), 'req-4');
		const init = /** @type {any} */ (fetchMock.mock.calls[0]?.[1]);
		expect(init?.credentials).toBe('include');
	});

	it('reports the push status to the observer', async () => {
		stubFetch(403);
		const onStatus = vi.fn();
		await makePusher('https://api.example/list/push', sessionCookie(), onStatus)(
			/** @type {any} */ ({}),
			'req-3'
		);
		expect(onStatus).toHaveBeenCalledWith(403);
	});
});

describe('storeName', () => {
	it('is stable for an account/entity pair', () => {
		expect(storeName('a/1', 'l/1')).toBe('a/1:l/1');
	});

	it('names the anonymous store with a null account', () => {
		// `null` is a real, meaningful value here — it is the anonymous
		// store, which is exactly the one #43 was wrongly opening.
		expect(storeName(null, 'l/1')).toBe('null:l/1');
	});
});
