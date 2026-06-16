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
	// JavaScript Proxies; wrapping them in Svelte's deep-reactive
	// state proxy short-circuits property access and returns undefined
	// for everything (the state proxy's target is the inner Proxy's
	// empty `{}` target, and Svelte's get trap appears to check
	// own-property descriptors before falling through to Reflect.get,
	// so our inner Proxy's get trap never fires). $state.raw keeps
	// the value un-wrapped and still triggers reactivity on
	// re-assignment, which is all the template gate cares about.
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

	// Effects only run in the browser, not during server-side rendering.
	$effect(() => {
		// Don't fire initList until the session has resolved at least
		// once. On direct nav (reload, bookmark, deep link) the
		// layout's onMount races this effect; without the gate we'd
		// push initList with accountId=null, creating an ownerless
		// entity, before the real account is known.
		if (!sessionState.hasLoaded) return;

		const replicacheList = initList({
			accountId: sessionState.currentAccountId,
			// Don't fire the client-side initList shortcut when the
			// invitee is arriving from a `?from_invite=1` link: we
			// know the entity exists server-side, and the optimistic
			// local init would write the invitee as owner, hiding
			// the InviteBanner before pull reconciliation lands.
			skipClientInit:
				page.url.searchParams.get('from_invite') === '1',
			// Attribute a freshly created list to the active workspace
			// (no-op when opening an existing list — store isn't empty).
			workspaceId: sessionState.currentWorkspaceId,
			// user_id: data.user?.username || 'my-test-user'
			listId: data.list_id,
			onToast: (event) => {
				// Reassign creates a new reference for the $effect in
				// UndoToast to detect; mutating fields wouldn't trigger
				// reactivity on the prop.
				toastEvent = event;
			},
			onConfirm: (mutator) =>
				// Bridges the runtime's awaited Promise to the UI: stash
				// the resolver alongside the mutator name; the toast
				// component calls resolve(true|false) when the user picks.
				new Promise((resolve) => {
					pendingConfirm = { mutator, resolve };
				})
		});

		onUndoClick = () => {
			replicacheList.undoRuntime.undo();
		};

		// what if we do ListSchema.parse(replicacheList.list) or something?
		// Hmm i think parsing within the component is better for composability
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
				goto(`/l/${suffix}/share`);
			}
		});

		// Return a cleanup function, which is called whenever the
		// effect refires as well as when the component is destroyed.
		return () => {
			unbindKeymap();
			replicacheList.client.close();
			ws?.close(1000);
		};
	});
</script>

{#if page.url.searchParams.get('from_invite') === '1' && sessionState.hasLoaded}
	<!-- Gate on hasLoaded so we don't flash the "Sign in to accept"
	     variant of the banner during the brief window between page
	     mount and the layout's session fetch resolving. Without the
	     gate, a magic-link-redirected invitee sees the wrong banner
	     for ~200ms before it flips to "Accept as <email>". -->
	<InviteBanner
		entityId={data.list_id}
		entityType="list"
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
		<List
			data={list_data}
			{list}
			{mutators}
			{mutateWithUndo}
			{undoRuntime}
		></List>
	{:else}
		<p>Loading list…</p>
	{/if}
</svelte:boundary>

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast pending={pendingConfirm} setPending={(p) => (pendingConfirm = p)} />

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
