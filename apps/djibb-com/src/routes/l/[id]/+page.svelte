<script>
	import { untrack } from 'svelte';

	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';
	import { bindUndoKeymap } from '$lib/keymap/global.js';

	import { decodeWSMessage } from '@djibb/protocol/websocket/constants';

	import ConfirmToast from '$lib/components/ConfirmToast.svelte';
	import InviteBanner from '$lib/components/InviteBanner.svelte';
	import List from '$lib/components/List.svelte';
	import SessionExpiredBanner from '$lib/components/SessionExpiredBanner.svelte';
	import StrandedWorkBanner from '$lib/components/StrandedWorkBanner.svelte';
	import SyncIndicator from '$lib/components/SyncIndicator.svelte';
	import UndoToast from '$lib/components/UndoToast.svelte';
	import { getSessionState } from '$lib/session.svelte.js';
	import { createStrandedState } from '$lib/replicache/stranded.svelte.js';
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

	// $state.raw for the same reason as the mutator proxies above: the
	// object exposes `status` as a getter over an inner `$state`, and
	// the deep-reactive proxy would shadow it.
	/** @type {ReturnType<typeof import('$lib/replicache/syncStatus.svelte.js').createSyncStatusState> | undefined} */
	let syncStatus = $state.raw();

	// The account the live client pushes as, captured at init. Held apart
	// from `sessionState.currentAccountId` on purpose: the session can
	// change out from under a running client (signing out of one of
	// several accounts), and the gap between the two is what the banner
	// reads to tell "expired" from "signed out of that account".
	/** @type {string | null} */
	let actingAccountId = $state.raw(null);

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

		// The `?new=1` marker authorizes the one-time optimistic init for a
		// genuine creation. Read it untracked: we strip it from the URL the
		// moment it's consumed (below), and we don't want that rewrite to
		// re-run this effect and needlessly rebuild the Replicache client.
		const isNew = untrack(() => page.url.searchParams.get('new') === '1');

		const replicacheList = initList({
			accountId: sessionState.currentAccountId,
			// Only a genuine creation (the `?new=1` marker set by the
			// "+ New list" button) fires the optimistic local initList.
			// Every other arrival — direct nav, deep link, invitation
			// link, or the homepage example Blank — opens an entity that
			// already exists server-side, so firing init would push a
			// doomed mutation and write the local actor as owner (hiding
			// the InviteBanner before pull reconciliation lands).
			// Subsumes the old `from_invite` skip.
			skipClientInit: !isNew,
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
		syncStatus = replicacheList.syncStatus;
		actingAccountId = replicacheList.actingAccountId;

		// The marker has now been consumed by the init decision above (its
		// only job), whether or not an optimistic write actually fired —
		// `initList` no-ops the create on a non-empty store. Strip it so a
		// copied or refreshed URL can't re-fire a doomed init against the
		// now-existing entity. (The server skip-and-acks such a push, but
		// not firing it is cleaner.) Untracked so the rewrite doesn't
		// re-run this effect.
		if (isNew) {
			untrack(() => {
				const params = new URLSearchParams(page.url.searchParams);
				params.delete('new');
				const qs = params.toString();
				replaceState(`${page.url.pathname}${qs ? `?${qs}` : ''}`, page.state);
			});
		}

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
			replicacheList.syncStatus.close();
			replicacheList.client.close();
			ws?.close(1000);
		};
	});

	// Pending mutations are keyed to this entity's client, so bring the
	// user back here after signing in — that's where the queue drains.
	let signInHref = $derived(
		`/accounts?next=${encodeURIComponent(page.url.pathname)}`
	);

	// Unflushed work on this entity belonging to an account we are NOT
	// acting as (GH #46). Invisible to the sync tracker by construction —
	// it watches the queue of the store we have open, and this is work in
	// a store we don't. Fed to both surfaces from one place so they can't
	// disagree about whether the app is lying: the banner offers the way
	// out, the indicator merely stops claiming "All changes saved" over
	// the top of it.
	//
	// Keyed on `actingAccountId`, not the session's current account: the
	// two differ on exactly the path this exists for.
	const stranded = createStrandedState({
		entityId: () => data.list_id,
		actingAccountId: () => actingAccountId
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

{#if syncStatus}
	<SessionExpiredBanner
		status={syncStatus.status}
		{signInHref}
		onRetry={() => syncStatus?.retry()}
		{actingAccountId}
		sessionAccounts={sessionState.accounts}
	/>
	<StrandedWorkBanner
		{stranded}
		sessionAccounts={sessionState.accounts}
		canSwitch={(id) => sessionState.canSwitchToAccount(id)}
		onSwitch={(id) => sessionState.switchToAccount(id)}
		{signInHref}
	/>
	<div class="sync-bar">
		<SyncIndicator
			status={syncStatus.status}
			{signInHref}
			stranded={stranded.claimants.length > 0}
		/>
	</div>
{/if}

<svelte:boundary {failed}>
	{#if list && mutators && mutateWithUndo && undoRuntime}
		<List data={list_data} {list} {mutators} {mutateWithUndo} {undoRuntime}
		></List>
	{:else}
		<p>Loading list…</p>
	{/if}
</svelte:boundary>

<UndoToast event={toastEvent} onUndo={() => onUndoClick?.()} />
<ConfirmToast
	pending={pendingConfirm}
	setPending={(p) => (pendingConfirm = p)}
/>

<style>
	/* Right-aligned above the list: present wherever edits happen, but
	   out of the way of the list chrome. */
	.sync-bar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 0.25rem;
	}
</style>

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
