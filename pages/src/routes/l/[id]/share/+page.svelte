<script>
	// @ts-check
	/**
	 * Share-route for Lists. Wires Replicache + websocket the same
	 * way /l/[id]/+page.svelte does, then hands the entity and
	 * mutators to the Share component. Same lifecycle: Replicache
	 * client per page mount, websocket cleaned up on unmount.
	 *
	 * setListAuthRules has an inverse (ADR 0005), so changes made
	 * here participate in the undo stack; the share form's "Save"
	 * still drives the mutation, and Cmd+Z from elsewhere in the
	 * app can roll it back via the standard friction-tier flow.
	 */
	import { page } from '$app/state';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';

	import { decodeWSMessage } from '$djibb/websocket/constants';

	import ConfirmToast from '$lib/components/ConfirmToast.svelte';
	import Share from '$lib/components/Share.svelte';
	import UndoToast from '$lib/components/UndoToast.svelte';
	import { getSessionState } from '$lib/session.svelte.js';

	let data = $derived(page.data);

	/** @type {{ [x: string]: import('replicache').ReadonlyJSONValue }} */
	let list_data = $state({});

	/** @type {import('$djibb/list').List} */
	// @ts-ignore
	let list = $derived(list_data?.[data.list_id]);

	/** @type {import("$lib/replicache/types.js").ClientListMutators | undefined} */
	let mutators = $state.raw();

	/** @type {import('$lib/replicache/withUndo.svelte.js').ToastEvent | null} */
	let toastEvent = $state(null);

	/** @type {(() => void) | null} */
	let onUndoClick = $state(null);

	/** @type {import('$lib/components/ConfirmToast.svelte').Pending | null} */
	let pendingConfirm = $state(null);

	const sessionState = getSessionState();

	$effect(() => {
		// Don't fire initList until the session has resolved at least
		// once. On direct nav (page reload, bookmark, deep link) the
		// layout's onMount races this effect; without the gate we'd
		// push initList with accountId=null, creating an ownerless
		// entity, before the real account is known.
		if (!sessionState.hasLoaded) return;

		const replicacheList = initList({
			accountId: sessionState.currentAccountId,
			listId: data.list_id,
			onToast: (event) => {
				toastEvent = event;
			},
			onConfirm: (mutator) =>
				new Promise((resolve) => {
					pendingConfirm = { mutator, resolve };
				})
		});

		onUndoClick = () => {
			replicacheList.undoRuntime.undo();
		};

		list_data = replicacheList.list;
		mutators = replicacheList.mutate;

		const ws = initWebsocket(data.list_id, replicacheList.client.clientID);
		ws.addEventListener('message', (event) => {
			const msg = decodeWSMessage(event.data);
			if (!msg) return;
			if (msg.type === 'poke') {
				if (replicacheList) replicacheList.client.pull();
			} else if (msg.type === 'mutation_outcome') {
				replicacheList.undoRuntime.handleOutcome({
					status: msg.status,
					mutationID: msg.mutationID,
					reason: msg.reason,
					message: msg.message
				});
			}
		});

		return () => {
			replicacheList.client.close();
			ws?.close(1000);
		};
	});

	let suffix = $derived(data.list_id.split('/', 2)[1] ?? '');

	/**
	 * Pending invitations on this entity, surfaced by the
	 * `pending_invites/*` Replicache keyspace (ADR 0009 Slice 2).
	 * Only visible to owners/admins — the pull filter elides the
	 * keyspace for everyone else, so this array is naturally empty
	 * for non-managers.
	 *
	 * @type {import('$lib/types/invites.js').PendingInvite[]}
	 */
	let pendingInvites = $derived(
		Object.entries(list_data)
			.filter(([k]) => k.startsWith('pending_invites/'))
			.map(([, v]) => /** @type {any} */ (v))
	);
</script>

<svelte:head>
	<title>Share list — djibb</title>
</svelte:head>

{#if list && mutators}
	<Share
		entityId={data.list_id}
		entityType="list"
		entity={list}
		{mutators}
		currentAccountId={sessionState.currentAccountId}
		backHref={`/l/${suffix}`}
		{pendingInvites}
	/>
{:else}
	<p class="loading">Loading list…</p>
{/if}

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast
	pending={pendingConfirm}
	setPending={(p) => (pendingConfirm = p)}
/>

<style>
	.loading {
		max-width: 42rem;
		margin: 2rem auto;
		padding: 0 1rem;
		opacity: 0.7;
	}
</style>
