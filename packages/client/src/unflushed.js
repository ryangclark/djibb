// @ts-check

/**
 * The unflushed-work ledger (GH #43).
 *
 * One durable record per (entity, account): *account X has mutations
 * for entity Y that have not reached the server from this browser.*
 *
 * ## Why this exists
 *
 * The Replicache store is named `<accountId>:<listId>`, and the app
 * derives `accountId` from **live session state**. So when a session
 * expires and the tab reloads, `currentAccountId` reads `null`, the
 * page opens a `null:<listId>` store, and the queued mutations are
 * stranded in a store nobody is looking at. Worse, the new store's
 * queue is empty and pushes anonymously — so it succeeds, and the sync
 * indicator cheerfully reports "All changes saved" over the top of work
 * that is going nowhere. That is the precise illusion #6/#7 exist to
 * kill, in its worst form.
 *
 * The inference is what's broken: a null session does not mean "this is
 * an anonymous client". The account that enqueued those mutations
 * hasn't changed — only our *evidence* of it went away. This ledger is
 * that evidence, kept somewhere the session can't take with it.
 *
 * ## Why it isn't keyed on sign-out
 *
 * An earlier sketch tried to distinguish "signed out deliberately" from
 * "session expired". That distinction is unnecessary and wrong: work
 * that never reached the server is stuck either way, and is recoverable
 * either way. The ledger records *unflushed work*, not *why the session
 * ended*, so both paths converge on the same (correct) banner. Sign-out
 * therefore needs no special case — see `discardUnflushed` for the one
 * deliberate exception, where the user explicitly asks to throw the
 * work away.
 *
 * ## Over-claiming is the safe direction
 *
 * Entries are written *synchronously, before* the mutation fires (see
 * `wrapMutators`), never after. If they were written after — from a
 * pending-count callback, say — a tab closed in the gap would leave a
 * persisted mutation with no ledger entry: a permanent orphan, which is
 * the original bug, just rarer and harder to find.
 *
 * Writing first means an entry can outlive its mutations (if the tab
 * dies between the stamp and the mutate, or a push lands before we
 * observe the drain). That's fine and self-healing: a stale entry costs
 * a stale store name for one load, and the tracker clears it the moment
 * it sees a pending count of zero. Under-claiming costs data; over-
 * claiming costs a store name. We over-claim.
 *
 * Storage is injected rather than reached for: `@djibb/client` is
 * framework- and env-free (ADR 0014) and is imported by the CLI, which
 * has no `localStorage`. The webapp supplies the adapter, exactly as it
 * supplies the API origin.
 */

import { dropDatabase, makeIDBName } from 'replicache';
import { SCHEMA_VERSION, storeName } from './replicache.js';

/** Namespace for every ledger key. One key per entity. */
const PREFIX = 'djibb.unflushed.';

/**
 * A `localStorage`-shaped adapter. Deliberately the minimum surface —
 * anything that can do these four operations works, including an
 * in-memory map in tests.
 *
 * @typedef {object} LedgerStorage
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 * @property {() => string[]} keys
 */

/**
 * Keys are per-entity rather than one big JSON blob on purpose. A
 * single blob would force every write to read-modify-write the whole
 * ledger, so two tabs stamping *different* entities at the same moment
 * could clobber each other. Per-entity keys narrow that window to two
 * tabs touching the same entity — where the value being written is the
 * same anyway.
 *
 * @param {string} entityId
 */
function keyFor(entityId) {
	return `${PREFIX}${entityId}`;
}

/** @typedef {ReturnType<typeof createUnflushedLedger>} UnflushedLedger */

/**
 * @param {object} input
 * @param {LedgerStorage} input.storage
 */
export function createUnflushedLedger({ storage }) {
	// Monotonic count of marks made by this ledger instance. The sync
	// tracker samples it either side of its (async) pending-count read so
	// it can tell whether a claim was staked *while that read was in
	// flight* — see `createSyncTracker`. Without it, a read that began
	// before a mutation and resolved after the mark would retire a claim
	// for work that is about to become durable: an orphan, which is the
	// one outcome this whole module exists to prevent.
	let marks = 0;

	// Mutations that have been claimed but whose local write has not yet
	// settled. A pending-count read taken in that window reports a queue
	// that does not yet contain them, so it must not be used to retire
	// anything — see `inFlight` below and `refreshPending` in the tracker.
	let inFlight = 0;

	/**
	 * @param {string} entityId
	 * @returns {string[]} account ids, least-recent first
	 */
	function accountsFor(entityId) {
		const raw = storage.getItem(keyFor(entityId));
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter(a => typeof a === 'string')
				: [];
		} catch {
			// A corrupt entry must not wedge entity loading. Treat it as
			// absent; the next mutation re-stamps it.
			return [];
		}
	}

	return {
		accountsFor,

		/**
		 * How many claims this ledger has staked. Strictly increasing;
		 * the value itself is meaningless — only whether it *changed*
		 * across an await.
		 */
		markVersion() {
			return marks;
		},

		/**
		 * How many claimed mutations have not yet settled locally.
		 *
		 * Replicache's `mutate` persists asynchronously, so between the claim
		 * (synchronous, below) and the local commit there is a window in which
		 * `experimentalPendingMutations()` legitimately reports an empty queue
		 * for work that is about to exist. A read taken in that window is
		 * worthless for retiring claims — acting on it orphans the very
		 * mutation being claimed. While this is above zero, no pending-count
		 * read is trustworthy.
		 */
		inFlight() {
			return inFlight;
		},

		/**
		 * Record that `accountId` has unflushed work for `entityId`, and hold
		 * the claim un-retirable until `settled` resolves.
		 *
		 * Deliberately NOT memoised. A "we already wrote this" cache would
		 * skip re-writing a claim that something else — another tab, or a
		 * retirement we later decide was wrong — had removed in the meantime,
		 * turning a self-healing system into a silently wrong one. Re-writing
		 * a couple hundred bytes of localStorage per mutation is a price worth
		 * paying to have every mutation re-assert its own claim.
		 *
		 * @param {string} entityId
		 * @param {string} accountId
		 */
		mark(entityId, accountId) {
			marks += 1;

			const accounts = accountsFor(entityId);
			// Re-append so the tail is always the most recent claimant —
			// `resolveEffectiveAccount` reads it from there.
			const next = [...accounts.filter(a => a !== accountId), accountId];
			storage.setItem(keyFor(entityId), JSON.stringify(next));
		},

		/**
		 * Hold every claim un-retirable until this mutation's local write
		 * lands. Paired with `mark` by `wrapMutators`.
		 *
		 * @param {Promise<unknown>} settled
		 */
		trackMutation(settled) {
			inFlight += 1;
			Promise.resolve(settled)
				.catch(() => {})
				.finally(() => {
					inFlight -= 1;
				});
		},

		/**
		 * Drop one account's claim on an entity. Called when the pending
		 * count drains to zero — the work reached the server, so there is
		 * nothing left to recover.
		 *
		 * @param {string} entityId
		 * @param {string} accountId
		 */
		clear(entityId, accountId) {
			const accounts = accountsFor(entityId);
			// The tracker calls this on every observed-empty read, which is
			// every idle tick. Bail before touching storage when there is
			// nothing to retire.
			if (!accounts.includes(accountId)) return;

			const next = accounts.filter(a => a !== accountId);
			if (next.length === 0) {
				storage.removeItem(keyFor(entityId));
			} else {
				storage.setItem(keyFor(entityId), JSON.stringify(next));
			}
		},

		/**
		 * Every entity this account has unflushed work for. Drives the
		 * sign-out prompt ("N lists have unsaved changes").
		 *
		 * @param {string} accountId
		 * @returns {string[]} entity ids
		 */
		entitiesFor(accountId) {
			return storage
				.keys()
				.filter(k => k.startsWith(PREFIX))
				.map(k => k.slice(PREFIX.length))
				.filter(entityId => accountsFor(entityId).includes(accountId));
		}
	};
}

/**
 * Decides which account a Replicache client should *act as* — which
 * store it opens and which account its mutations claim.
 *
 * A live session always wins: this only speaks when the session is
 * gone. In that case a ledger entry means the work belongs to someone,
 * so we keep acting as them — the store name resolves back to where the
 * queue actually is, the pushes keep claiming that account (and so keep
 * being rejected 403, which is what raises the banner), and re-auth
 * flushes them.
 *
 * When several accounts have unflushed work for one entity — rare, but
 * possible on a shared device — the most recent claimant wins. Once its
 * queue drains its entry clears, and the next load picks up the next
 * one. It converges and never drops work; it just may take more than
 * one sign-in to fully drain, which is the honest cost of a case that
 * may never occur in practice.
 *
 * Returning `null` means "genuinely anonymous", which is the ordinary
 * path for a user who was never signed in — they have no ledger entry,
 * so nothing here changes their behaviour at all.
 *
 * @param {object} input
 * @param {string | null} input.accountId Live session's account, if any
 * @param {string} input.entityId
 * @param {ReturnType<typeof createUnflushedLedger>} input.ledger
 * @returns {string | null}
 */
export function resolveEffectiveAccount({ accountId, entityId, ledger }) {
	if (accountId) return accountId;
	const claimants = ledger.accountsFor(entityId);
	return claimants[claimants.length - 1] ?? null;
}

/**
 * Claims on this entity that the effective account will never drain
 * (GH #46) — i.e. the work `resolveEffectiveAccount` deliberately
 * declined to act as.
 *
 * ## Why this is a separate question
 *
 * The rule above gives an unconditional win to the live session, and it
 * must: sessions here are multi-account, so a ledger claim outranking a
 * live account would drag a genuinely different user on a shared device
 * into someone else's store and push as them. That is strictly worse
 * than the state it would fix.
 *
 * But "we correctly declined to act as A" is not the same as "there is
 * nothing of A's here". On a device signed in as A and B, work queued
 * as A and left unflushed (A's session dropped, or A signed out with
 * "keep changes") sits in `A:<entity>`, while opening the entity as B
 * opens `B:<entity>` — a different store, empty queue, pushes fine, and
 * the indicator says **All changes saved**. Every word of that is true
 * about B and a lie about the entity. This function is what lets the UI
 * say the true thing instead: *another account has unsaved changes
 * here.*
 *
 * Resolution stays; disclosure is the fix.
 *
 * ## It can over-report, by construction
 *
 * Claims are stamped before their mutation lands and retired only by a
 * client acting as the claimant (see the over-claiming note above), so a
 * claim can outlive its work — and nobody but that account can notice.
 * A rare false "A has unsaved changes here" is the cost of never missing
 * a true one, which is the same trade the ledger already makes. The
 * escape hatch is that both offered actions (switch, discard) are
 * harmless against an empty store.
 *
 * @param {object} input
 * @param {ReturnType<typeof createUnflushedLedger>} input.ledger
 * @param {string} input.entityId
 * @param {string | null} input.effectiveAccountId The account this
 *   client is actually acting as — from `resolveEffectiveAccount`, not
 *   from the session. They differ on exactly the paths that matter.
 * @returns {string[]} account ids, least-recent first
 */
export function strandedClaims({ ledger, entityId, effectiveAccountId }) {
	return ledger
		.accountsFor(entityId)
		.filter(accountId => accountId !== effectiveAccountId);
}

/**
 * The nuclear option behind the sign-out prompt: throw away every
 * unflushed mutation this account holds in this browser.
 *
 * Deleting the ledger entry alone would not do it — that would only
 * make the work *unreachable*, leaving the mutations to rot in an
 * IndexedDB store nothing will ever open again. If the user says
 * discard, actually discard: drop the store, then the claim.
 *
 * Irreversible, which is why it is never the default and never
 * automatic. Sign-out keeps unflushed work by default precisely
 * because it is still recoverable.
 *
 * ## Why this can time out
 *
 * `dropDatabase` bottoms out in `indexedDB.deleteDatabase`, which
 * **blocks rather than rejects** while any connection to that database
 * is open — it simply never fires `success`. Another tab sitting on the
 * same list holds such a connection. Awaiting it bare would hang
 * forever, and by the time we get here the user is already signed out
 * (the sign-out request goes first, deliberately), so they'd be left
 * signed out and staring at a spinner that never resolves, with no
 * error to catch — a hang is not a rejection.
 *
 * So each drop races a deadline, and a drop that doesn't land throws
 * with the entities it couldn't remove. The claims for those are left
 * in place: the work is still there, so saying otherwise would be a
 * lie, and a surviving claim is recoverable while a false "removed" is
 * not.
 *
 * Note that a timed-out delete is not cancelled — it stays queued in the
 * browser and may well land later, once the tab holding the store closes.
 * The kept claim then points at a store that is empty (or gone). That is
 * benign and self-healing: the next load opens it, finds nothing pending,
 * and the tracker retires the claim on its own. We deliberately do not
 * try to detect this — a claim outliving its work costs a stale store
 * name for one load, which is the cheap direction to be wrong in.
 *
 * @param {object} input
 * @param {ReturnType<typeof createUnflushedLedger>} input.ledger
 * @param {string} input.accountId
 * @param {string[]} [input.entityIds] Discard only these entities'
 *   stores rather than every one this account holds. Sign-out is
 *   account-wide and passes nothing; the stranded-work banner (GH #46)
 *   speaks for one entity and must not throw away the account's work on
 *   the lists the user isn't even looking at. Ids with no claim for this
 *   account are ignored — there is no store of ours to drop.
 * @param {number} [input.timeoutMs=5000] Per-store deadline.
 * @param {(dbName: string) => Promise<void>} [input.dropStore] Seam for tests.
 * @returns {Promise<string[]>} the entity ids whose stores were dropped
 * @throws {UnflushedDiscardError} if any store could not be dropped
 */
export async function discardUnflushed({
	ledger,
	accountId,
	entityIds,
	timeoutMs = 5000,
	dropStore = dropDatabase
}) {
	const claimed = ledger.entitiesFor(accountId);
	// Intersect rather than trust the caller's list: dropping a store for
	// an entity this account never claimed would delete someone's work on
	// the strength of a stale prop.
	const entities = entityIds
		? claimed.filter(id => entityIds.includes(id))
		: claimed;
	/** @type {string[]} */
	const dropped = [];
	/** @type {string[]} */
	const blocked = [];

	for (const entityId of entities) {
		// The IDB name is derived from the same store name and schema
		// version the client is built with — shared so the drop path
		// can't drift away from the create path and silently miss.
		const dbName = makeIDBName(storeName(accountId, entityId), SCHEMA_VERSION);

		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error('timed out')),
				timeoutMs
			);
		});

		try {
			await Promise.race([dropStore(dbName), deadline]);
			// Retire the claim only once the store is actually gone.
			ledger.clear(entityId, accountId);
			dropped.push(entityId);
		} catch {
			blocked.push(entityId);
		} finally {
			clearTimeout(timer);
		}
	}

	if (blocked.length) throw new UnflushedDiscardError(dropped, blocked);
	return dropped;
}

/**
 * Some stores survived a discard — almost always because another tab
 * still has them open. Carries both lists so the UI can tell the user
 * exactly what did and didn't happen, rather than claiming a removal
 * that didn't occur.
 */
export class UnflushedDiscardError extends Error {
	/**
	 * @param {string[]} dropped
	 * @param {string[]} blocked
	 */
	constructor(dropped, blocked) {
		super(
			`could not remove unsaved changes for ${blocked.length} ` +
				`entit${blocked.length === 1 ? 'y' : 'ies'} — ` +
				'another tab may still have them open'
		);
		this.name = 'UnflushedDiscardError';
		this.dropped = dropped;
		this.blocked = blocked;
	}
}
