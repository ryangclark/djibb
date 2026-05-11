<script>
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';
	import { bindUndoKeymap } from '$lib/keymap/global.js';

	import { decodeWSMessage } from '$djibb/websocket/constants';

	import ConfirmToast from '$lib/components/ConfirmToast.svelte';
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

	/** @type {import("$lib/replicache/types.js").ClientListMutators | undefined} */
	let mutateWithUndo = $state();

	/** @type {any} */
	let undoRuntime = $state();

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
		mutateWithUndo = replicacheList.mutateWithUndo;
		undoRuntime = replicacheList.undoRuntime;

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

		const unbindKeymap = bindUndoKeymap({
			runtime: replicacheList.undoRuntime,
			onShareShortcut: () => {
				const suffix = data.list_id.split('/', 2)[1] ?? '';
				goto(`/t/${suffix}/share`);
			}
		});

		return () => {
			unbindKeymap();
			replicacheList.client.close();
			ws?.close(1000);
		};
	});
</script>

<svelte:boundary {failed}>
	{#if list && mutators && mutateWithUndo && undoRuntime}
		<List
			data={list_data}
			{list}
			{mutators}
			{mutateWithUndo}
			{undoRuntime}
		></List>
	{:else}
		<p>Loading template…</p>
	{/if}
</svelte:boundary>

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast pending={pendingConfirm} setPending={(p) => (pendingConfirm = p)} />

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
