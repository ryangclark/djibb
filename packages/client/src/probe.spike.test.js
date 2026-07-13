// @ts-check

/**
 * SLICE 0 SPIKE — docs/plans/verified-stranded-work.md
 *
 * The whole "verify the claim before you shout about it" plan rests on
 * one assumption about Replicache, and the plan is void if it's false:
 *
 *   A SECOND Replicache instance, opened on the SAME store name by a
 *   different client, can see mutations the FIRST client left pending —
 *   and reading them that way neither consumes, confirms, nor corrupts
 *   them.
 *
 * If `experimentalPendingMutations()` is scoped to the calling client,
 * a freshly-opened probe always reads zero, and the plan inverts into
 * its own worst case: we'd retire live claims and delete real work.
 *
 * Real IndexedDB (via `fake-indexeddb`) and real Replicache, because
 * the question is entirely about their behaviour. `kvStore: 'mem'`
 * would be a cheaper harness and a worthless one: a memory store that
 * isn't shared across instances would report zero pending for reasons
 * that have nothing to do with the question being asked, and we'd read
 * that as an answer.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { Replicache } from 'replicache';
import { mutators } from '@djibb/protocol/list/mutators/client';
import { SCHEMA_VERSION, storeName } from './replicache.js';

const ACCOUNT = 'acct_a';
// Ids are length-checked (`ID_LENGTH` + prefix), so a pretty name like
// 'l/spike' is rejected by the mutator's own schema before it can ever
// become a pending mutation. Shape it like a real one.
const ENTITY = `l/${'a'.repeat(21)}`;
const NAME = storeName(ACCOUNT, ENTITY);

/** Never contacted. A probe that pushes is a probe that acts as an
 * account the user did not choose — the one thing this must never do. */
const inertPusher = async () => ({
	httpRequestInfo: { httpStatusCode: 200, errorMessage: '' }
});
const inertPuller = async () => ({
	httpRequestInfo: { httpStatusCode: 200, errorMessage: '' }
});

/** The envelope `wrapMutators` would normally inject. */
function newListArgs() {
	return {
		listId: ENTITY,
		workspaceId: null,
		accountId: ACCOUNT,
		timestamp_client: new Date().toISOString()
	};
}

/**
 * Replicache moves mutations from the in-memory dag to the persistent one
 * on its OWN schedule — there is no public `persist()`. Close a client
 * before that lands and the mutation exists nowhere on disk: the probe
 * reads an empty store and (correctly) says zero.
 *
 * The first version of this spike closed immediately and read 0 pending,
 * which looked exactly like "the plan is dead". It wasn't; the store was
 * genuinely empty. Distinguishing those two required this wait, and it is
 * the single most important thing the spike learned — see the plan's
 * "under-report" hazard.
 */
async function letItPersist() {
	await new Promise((r) => setTimeout(r, 1500));
}

/** @type {Replicache[]} */
const open = [];

/**
 * @param {object} [opts]
 * @param {import('replicache').Pusher} [opts.pusher]
 */
function openStore({ pusher = inertPusher } = {}) {
	const rep = new Replicache({
		name: NAME,
		schemaVersion: SCHEMA_VERSION,
		mutators,
		pusher,
		puller: inertPuller,
		pullInterval: null,
		kvStore: 'idb'
	});
	open.push(rep);
	return rep;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((rep) => rep.close()));
});

describe('SPIKE: can a second client see the first client’s pending queue?', () => {
	it('yes — pending mutations are visible across clients on the same store', async () => {
		// ── Client 1: enqueue work that cannot reach a server. ──
		const first = openStore();
		await first.mutate.initList(newListArgs());

		const ownPending = await first.experimentalPendingMutations();
		expect(ownPending.length).toBeGreaterThan(0);

		// Close it, exactly as a tab going away would.
		await letItPersist();
		await first.close();

		// ── Client 2 (the probe): different client, same store. ──
		// This is the load-bearing read. If it comes back empty, the plan
		// is dead and the banner has to keep trusting the ledger.
		const probe = openStore();
		// The read must not race the open: `experimentalPendingMutations()`
		// on a not-yet-opened client throws "Missing head main" rather than
		// returning empty. A probe that treats that as zero would retire a
		// live claim, so the real `probeUnflushed` must await readiness (and
		// must NOT swallow the throw).
		await probe.clientID;
		await probe.query((tx) => tx.get('nothing'));
		const seen = await probe.experimentalPendingMutations();

		expect(seen.length).toBe(ownPending.length);
		expect(seen.map((m) => m.name)).toContain('initList');
	});

	it('and the probe does not consume, confirm, or corrupt the queue', async () => {
		// The scarier half. A probe whose inert pusher "succeeds" must not
		// let Replicache believe those mutations were pushed — confirmation
		// is supposed to arrive only via a pull's lastMutationID, but that
		// is an assumption about someone else's internals, so pin it.
		const first = openStore();
		await first.mutate.initList(newListArgs());
		await letItPersist();
		await first.close();

		// Probe it, with an inert pusher that reports HTTP 200.
		const probe = openStore();
		await probe.clientID;
		await probe.query((tx) => tx.get('nothing'));
		await probe.experimentalPendingMutations();
		// Give the probe's own push loop every chance to misbehave.
		await probe.push();
		await new Promise((r) => setTimeout(r, 100));
		await probe.close();

		// Now reopen with a pusher that actually records what it is handed.
		// The mutation must STILL be there and STILL be pushable — if the
		// probe ate it, this is where the user's work quietly disappeared.
		/** @type {any[]} */
		const pushed = [];
		const recording = async (/** @type {any} */ body) => {
			pushed.push(...body.mutations);
			return { httpRequestInfo: { httpStatusCode: 200, errorMessage: '' } };
		};

		const after = openStore({ pusher: recording });
		await after.clientID;
		await after.query((tx) => tx.get('nothing'));
		const stillPending = await after.experimentalPendingMutations();
		expect(stillPending.length).toBeGreaterThan(0);

		await after.push();
		await new Promise((r) => setTimeout(r, 100));
		expect(pushed.map((m) => m.name)).toContain('initList');
	});
});
