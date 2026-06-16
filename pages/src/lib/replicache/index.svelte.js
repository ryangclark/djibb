import { dev } from '$app/environment';
import { createReplicacheClient, wrapMutators } from '@djibb/client/replicache';
import { createUndoRuntime } from './withUndo.svelte.js';

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

	const replicacheClient = InitReplicacheClient({ accountId, listId });
	const mutate = wrapMutators(replicacheClient.mutate, { accountId });

	// Undo runtime layered on top of `mutate`. Both firing paths
	// (`mutate.foo` / `mutateWithUndo.foo`) flow through the same
	// envelope wrapper; only undo bookkeeping differs. Per ADR 0005.
	const undoRuntime = createUndoRuntime({
		client: replicacheClient,
		mutate,
		accountId,
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
 */
export function InitReplicacheClient({ accountId, listId }) {
	return createReplicacheClient({
		accountId,
		listId,
		licenseKey: import.meta.env.VITE_REPLICACHE_LICENSE_KEY,
		baseUrl: import.meta.env.VITE_REPLICACHE_BASE_URL,
		secure: !dev
	});
}
