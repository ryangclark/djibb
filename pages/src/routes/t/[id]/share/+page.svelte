<script>
	// @ts-check
	/** Share-route for Templates. See /l/[id]/share/+page.svelte for
	 *  the explanation — this is its templates twin. */
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
					mutationID: msg.mutationID
				});
			}
		});

		return () => {
			replicacheList.client.close();
			ws?.close(1000);
		};
	});

	let suffix = $derived(data.list_id.split('/', 2)[1] ?? '');
</script>

<svelte:head>
	<title>Share template — djibb</title>
</svelte:head>

{#if list && mutators}
	<Share
		entityId={data.list_id}
		entityType="template"
		entity={list}
		mutators={mutators}
		currentAccountId={sessionState.currentAccountId}
		backHref={`/t/${suffix}`}
	/>
{:else}
	<p class="loading">Loading template…</p>
{/if}

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast pending={pendingConfirm} setPending={(p) => (pendingConfirm = p)} />

<style>
	.loading {
		max-width: 42rem;
		margin: 2rem auto;
		padding: 0 1rem;
		opacity: 0.7;
	}
</style>
