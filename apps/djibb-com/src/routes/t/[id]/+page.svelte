<script>
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';
	import { bindUndoKeymap } from '$lib/keymap/global.js';

	import { decodeWSMessage } from '@djibb/protocol/websocket/constants';

	import ConfirmToast from '$lib/components/ConfirmToast.svelte';
	import InviteBanner from '$lib/components/InviteBanner.svelte';
	import List from '$lib/components/List.svelte';
	import UndoToast from '$lib/components/UndoToast.svelte';
	import { getSessionState } from '$lib/session.svelte.js';
	import z, { ZodError } from 'zod';

	let data = $derived(page.data);

	/** @type {{ [x: string]: import('replicache').ReadonlyJSONValue }}*/
	let list_data = $state({});

	/** @type {import('@djibb/protocol/list').List}*/
	// @ts-ignore
	let list = $derived(list_data?.[data.list_id]);

	// $state.raw, not $state. mutators / mutateWithUndo are custom
	// JavaScript Proxies; Svelte's deep-reactive state proxy
	// short-circuits property access on them. See /l/[id]/+page.svelte
	// for the full explanation.
	/** @type {import("@djibb/client/types").ClientListMutators | undefined} */
	let mutators = $state.raw();

	/** @type {import("@djibb/client/types").ClientListMutators | undefined} */
	let mutateWithUndo = $state.raw();

	/** @type {any} */
	let undoRuntime = $state.raw();

	/** @type {import('$lib/replicache/withUndo.svelte.js').ToastEvent | null} */
	let toastEvent = $state(null);

	/** @type {(() => void) | null} */
	let onUndoClick = $state(null);

	/** @type {import('$lib/components/ConfirmToast.svelte').Pending | null} */
	let pendingConfirm = $state(null);

	const sessionState = getSessionState();

	$effect(() => {
		// See /l/[id]/+page.svelte for the long-form comment on why
		// this gate is necessary. tl;dr: direct nav races session load.
		if (!sessionState.hasLoaded) return;

		const replicacheList = initList({
			accountId: sessionState.currentAccountId,
			// Only a genuine creation (the `?new=1` marker set by the
			// "+ New template" button) fires the optimistic local
			// initList. Every other arrival — direct nav, deep link,
			// invitation link, or the homepage example Blank — opens an
			// entity that already exists server-side, so firing init
			// would push a doomed mutation and (until pull lands) flash
			// an empty shell over the real content. Subsumes the old
			// `from_invite` skip.
			skipClientInit: page.url.searchParams.get('new') !== '1',
			// Attribute a freshly created template to the active workspace
			// (no-op when opening an existing one — store isn't empty).
			workspaceId: sessionState.currentWorkspaceId,
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
					mutationID: msg.mutationID,
					reason: msg.reason,
					message: msg.message
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

{#if page.url.searchParams.get('from_invite') === '1' && sessionState.hasLoaded}
	<!-- See /l/[id]/+page.svelte for the long-form comment. tl;dr:
	     avoid flashing the wrong banner variant during the brief
	     pre-session-load window. -->
	<InviteBanner
		entityId={data.list_id}
		entityType="template"
		entityName={list?.name ?? null}
		authorizationRules={list?.authorization_rules}
		{mutators}
		sessionAccounts={sessionState.accounts}
		currentAccountId={sessionState.currentAccountId}
		pathname={page.url.pathname}
	/>
{/if}

<svelte:boundary {failed}>
	{#if list && mutators && mutateWithUndo && undoRuntime}
		<List data={list_data} {list} {mutators} {mutateWithUndo} {undoRuntime}
		></List>
	{:else}
		<p>Loading template…</p>
	{/if}
</svelte:boundary>

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast
	pending={pendingConfirm}
	setPending={(p) => (pendingConfirm = p)}
/>

{#snippet failed(
	/** @type {unknown} */
	error,
	/** @type {() => void} */
	resetFn
)}
	{#if error instanceof ZodError}
		<div class="flex justify-between">
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
