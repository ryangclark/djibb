<script>
	import { page } from '$app/state';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';

	import { decodeWSMessage } from '$djibb/websocket/constants';

	import List from '$lib/components/List.svelte';
	import UndoToast from '$lib/components/UndoToast.svelte';
	import { getSessionState } from '$lib/session.svelte.js';
	import z, { ZodError } from 'zod';

	let data = $derived(page.data);

	/** @type {{ [x: string]: import('replicache').ReadonlyJSONValue }}*/
	let list_data = $state({});

	/** @type {import('$djibb/list').List}*/
	// @ts-ignore
	let list = $derived(list_data?.[data.list_id]);

	/** @type {import("$lib/replicache/types.js").ClientListMutators | undefined} */
	let mutators = $state();

	/** @type {import('$lib/replicache/withUndo.svelte.js').ToastEvent | null} */
	let toastEvent = $state(null);

	/** @type {(() => void) | null} */
	let onUndoClick = $state(null);

	const sessionState = getSessionState();

	// Effects only run in the browser, not during server-side rendering.
	$effect(() => {
		const replicacheList = initList({
			accountId: sessionState.currentAccountId,
			// user_id: data.user?.username || 'my-test-user'
			listId: data.list_id,
			onToast: (event) => {
				// Reassign creates a new reference for the $effect in
				// UndoToast to detect; mutating fields wouldn't trigger
				// reactivity on the prop.
				toastEvent = event;
			}
		});

		onUndoClick = () => {
			replicacheList.undoRuntime.undo();
		};

		// what if we do ListSchema.parse(replicacheList.list) or something?
		// Hmm i think parsing within the component is better for composability
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

		// Return a cleanup function, which is called whenever the
		// effect refires as well as when the component is destroyed.
		return () => {
			replicacheList.client.close();
			ws?.close(1000);
		};
	});
</script>

<svelte:boundary {failed}>
	{#if list}
		<List data={list_data} {list} {mutators}></List>
	{:else}
		<p>Loading list…</p>
	{/if}
</svelte:boundary>

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />

<!-- @UPGRADE
 Move the failure UI to within the <List> component for true
 composability. I don't know how to do that yet though because
 of how the error is handled/propagated. I think it'd have to handle
 all of its own errors without throwing any (if possible).
  -->
{#snippet failed(
	/** @type {unknown} */
	error,
	/** @type {() => void} */
	resetFn
)}
	{#if error instanceof ZodError}
		<div class="flex justify-between ">
			<h2 class="text-2xl">Validation Error</h2>
			<button class="border px-3" onclick={resetFn}>Reset</button>
		</div>
		<p>{z.prettifyError(error)}</p>
	{:else}
		<h2 class="text-2xl">Oh bother</h2>
		<p>We have encountered an error. Here's what we know:</p>
		<p>{error}</p>
	{/if}
{/snippet}
