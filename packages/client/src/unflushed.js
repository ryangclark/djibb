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
		 * Record that `accountId` has unflushed work for `entityId`.
		 * Idempotent, and cheap enough to call on every mutation.
		 *
		 * @param {string} entityId
		 * @param {string} accountId
		 */
		mark(entityId, accountId) {
			const accounts = accountsFor(entityId);
			// Re-append so the tail is always the most recent claimant —
			// `resolveEffectiveAccount` reads it from there.
			const next = [...accounts.filter(a => a !== accountId), accountId];
			storage.setItem(keyFor(entityId), JSON.stringify(next));
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
			const next = accountsFor(entityId).filter(a => a !== accountId);
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
 * @param {object} input
 * @param {ReturnType<typeof createUnflushedLedger>} input.ledger
 * @param {string} input.accountId
 * @returns {Promise<string[]>} the entity ids whose stores were dropped
 */
export async function discardUnflushed({ ledger, accountId }) {
	const entities = ledger.entitiesFor(accountId);
	for (const entityId of entities) {
		// The IDB name is derived from the same store name and schema
		// version the client is built with — shared so the drop path
		// can't drift away from the create path and silently miss.
		await dropDatabase(
			makeIDBName(storeName(accountId, entityId), SCHEMA_VERSION)
		);
		ledger.clear(entityId, accountId);
	}
	return entities;
}
