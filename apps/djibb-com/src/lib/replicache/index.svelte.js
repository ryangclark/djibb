import { createReplicacheClient, wrapMutators } from '@djibb/client/replicache';
import { resolveEffectiveAccount } from '@djibb/client/unflushed';
import { replicacheHost, replicacheSecure } from '$lib/config';
import { createUndoRuntime } from './withUndo.svelte.js';
import { createSyncStatusState } from './syncStatus.svelte.js';
import { unflushedLedger } from './ledger.js';

/**
 * Initializes the Replicache Client stuff.
 * This is mostly specific for a List instance.
 * We'll have to figure out how we might generalize stuff later.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 * @param {(event: import('./withUndo.svelte.js').ToastEvent) => void} [input.onToast]
 *   Wired to the route's UndoToast component. Discriminated union;
 *   `kind:'action'` for stack pushes, `kind:'auth'|'stale'|'gone'`
 *   for outcome-channel failures. ADR 0005.
 * @param {(name: string) => Promise<boolean>} [input.onConfirm]
 *   Friction-tier prompt; C.2 wires this to the confirm toast.
 * @param {boolean} [input.skipClientInit]
 *   Skip the local-empty-fires-initList shortcut. Pass when the
 *   caller KNOWS the entity already exists server-side and the
 *   local IDB is empty only because this is a fresh client (e.g.
 *   an invitee opening `/l/<id>?from_invite=1`). Without this,
 *   the optimistic initList writes the local user as owner,
 *   makes `authorized_accounts[me]` non-null in local state, and
 *   confuses any UI that derives "am I authorized?" from local
 *   data — most notably hiding the InviteBanner before pull
 *   reconciliation lands.
 * @param {string | null} [input.workspaceId]
 *   The active workspace's entity id, stamped onto the entity when the
 *   local-empty-fires-initList shortcut creates it. Only consequential
 *   on genuine creation (store empty AND !skipClientInit); ignored when
 *   opening an existing entity. `null` ⇒ workspace-less, as before.
 */
export function initList({
	accountId,
	listId,
	onToast,
	onConfirm,
	skipClientInit = false,
	workspaceId = null,
}) {
	/** @type {Object.<string, import('replicache').ReadonlyJSONValue>} */
	const listData = $state({});

	if (!listId) {
		throw new Error('Missing List Id!');
	}

	// Who this client ACTS AS, which is not always who the session says
	// we are (GH #43). A dead session reports `accountId: null`, but a
	// null session is not an anonymous client: if this account left
	// unflushed mutations for this entity, they're sitting in that
	// account's store, and opening the anonymous one instead would
	// strand them — and then cheerfully report "All changes saved" over
	// the top of them. The ledger remembers what the session forgot.
	//
	// Resolved exactly once and threaded through all three consumers,
	// because they must agree: the store we open, the account our
	// mutations claim, and the claim we retire on drain. If the store
	// said "account X" while the envelope said "anonymous", the queued
	// work would push as nobody and quietly apply to the wrong actor.
	//
	// Note this deliberately does NOT touch `sessionState` — the app at
	// large still correctly believes it is signed out. This is a
	// statement about which local store holds our work, nothing more.
	const effectiveAccountId = resolveEffectiveAccount({
		accountId,
		entityId: listId,
		ledger: unflushedLedger
	});

	// Built before the client because the client needs `notifyPush` at
	// construction time — it's wired into the pusher, which is where a
	// session expiry becomes visible (persistent push 401/403).
	const syncStatus = createSyncStatusState({
		// Retires the ledger claim once the work has actually landed.
		// Claims are written optimistically (before each mutation), so
		// observing an empty queue is the only thing that can retire one.
		onDrained: () => {
			if (effectiveAccountId) {
				unflushedLedger.clear(listId, effectiveAccountId);
			}
		},
		// Lets the tracker tell an empty queue apart from a stale read of
		// one: a claim staked while its pending-count read was in flight
		// must not be retired by that read (see `refreshPending`).
		markVersion: unflushedLedger.markVersion,
		// ...and a mutation claimed but not yet written is equally a reason
		// not to trust an empty-queue read.
		inFlight: unflushedLedger.inFlight
	});

	const replicacheClient = InitReplicacheClient({
		accountId: effectiveAccountId,
		listId,
		onPushStatus: syncStatus.notifyPush
	});
	syncStatus.attach(replicacheClient);

	const mutate = wrapMutators(replicacheClient.mutate, {
		accountId: effectiveAccountId,
		listId,
		ledger: unflushedLedger
	});

	// Undo runtime layered on top of `mutate`. Both firing paths
	// (`mutate.foo` / `mutateWithUndo.foo`) flow through the same
	// envelope wrapper; only undo bookkeeping differs. Per ADR 0005.
	const undoRuntime = createUndoRuntime({
		client: replicacheClient,
		mutate,
		// Effective, not session: the undo stack is keyed by
		// (account, entity) too (`stackStorageKey`), so a dead session
		// would point it at a different stack for the same reason it
		// pointed Replicache at a different store. Same question, same
		// answer — keep the two identities in lockstep.
		accountId: effectiveAccountId,
		listId,
		onToast,
		onConfirm
	});

	/**
	 * Callback function to handle updates to the Replicache store by
	 * updating the data in the `listData` state rune.
	 *
	 * This is defined here to have `listData` in scope.
	 *
	 * @type {import('replicache').ExperimentalWatchNoIndexCallback}
	 */
	function replicacheExperimentalWatchCallback(diffs) {
		for (const diff of diffs) {
			if (diff.op === 'add' || diff.op === 'change') {
				listData[diff.key] = diff.newValue;
			} else if (diff.op === 'del') {
				// Archive flow: the server's pull omits time_deleted
				// rows, so an archive (or an undo-of-create) lands as
				// a `del` op against the row's key. Drop the entry so
				// the row stops rendering. Parent.child_element_refs
				// may still reference the id transiently — the
				// rendering snippet filters those out silently.
				delete listData[diff.key];
			}
		}
	}

	// Watch for changes.
	replicacheClient.experimentalWatch(replicacheExperimentalWatchCallback, {
		initialValuesInFirstDiff: true
	});

	if (!skipClientInit) {
		replicacheClient
			.query((tx) => tx.isEmpty())
			.then((isEmpty) => {
				if (isEmpty) {
					// Stamp the actor's active workspace onto the brand-new
					// entity so it's attributed to the workspace it was
					// created in (the source of `workspace_id`, consumed by
					// "shared with me" dedup today and the Island view to
					// come). `null` when no workspace is selected.
					mutate.initList({
						listId,
						workspaceId
					});
				}
			});
	}

	// Return the Svelte stuff we'll use to interact with
	// the Replicache client.
	return {
		client: replicacheClient,
		mutate,
		mutateWithUndo: undoRuntime.mutateWithUndo,
		undoRuntime,
		syncStatus,
		// The account this client PUSHES AS — stamped into every mutation
		// envelope and fixed for the client's lifetime. Deliberately
		// surfaced rather than left implicit: it is not the same thing as
		// the session's current account (the session can change under a
		// live client), and that difference is precisely what
		// `SessionExpiredBanner` needs to tell an expired session apart
		// from an account that was signed out from under a running client.
		actingAccountId: accountId,
		get list() {
			return listData;
		}
	};
}

/**
 * Reads the app's Vite/SvelteKit environment and delegates to the
 * framework-agnostic client factory in `@djibb/client`. The env access
 * (`import.meta.env`, `$app/environment`) lives here on purpose —
 * `@djibb/client` never reads env so it stays portable; pages owns the
 * binding to Vite.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 * @param {(httpStatusCode: number) => void} [input.onPushStatus]
 */
export function InitReplicacheClient({ accountId, listId, onPushStatus }) {
	return createReplicacheClient({
		accountId,
		listId,
		baseUrl: replicacheHost,
		secure: replicacheSecure,
		onPushStatus
	});
}
