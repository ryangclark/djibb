<script>
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import { getSessionState } from '$lib/session.svelte';
	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';
	import { decodeWSMessage } from '$djibb/websocket/constants';
	import { WORKSPACE_REPLICACHE_KEY } from './_context.js';

	// ADR 0011 §7b.4: workspace pages run on Replicache against the
	// workspace's own DjibbList DO. The layout owns the client + websocket
	// so the members + settings + home pages share one connection (via
	// Svelte context — see `WORKSPACE_REPLICACHE_KEY`). Mutations
	// (`renameWorkspace`, `setWorkspaceImage`, `changeMemberRole`,
	// `removeMember`, `leaveMember`) dispatch through `mutate`.
	//
	// `initList` is reused with `skipClientInit: true` — workspaces are
	// minted by `createWorkspace` from `/workspaces`, not by `initList`,
	// so the empty-store shortcut would be wrong here.

	const session = getSessionState();
	let { children } = $props();

	const slug = $derived(page.params.slug);

	$effect(() => {
		if (slug && session.workspaces.length && session.currentWorkspaceSlug !== slug) {
			session.setActiveWorkspace(slug);
		}
	});

	const current = $derived(
		session.workspaces.find(w => w.workspace.slug === slug)
	);
	const workspaceId = $derived(current?.workspace.id ?? null);

	/** @type {{ [k: string]: import('replicache').ReadonlyJSONValue }} */
	let workspaceData = $state({});

	/** @type {any} */
	let mutate = $state.raw();

	// ADR 0011 §Step 7b.5: surface mutation_outcome frames to child
	// pages via context. Settings reads this to render slug-claim
	// failures (slug_taken / slug_reserved / slug_invalid /
	// unauthorized_role) — the only flow on this layout that needs
	// structured server-side error feedback. Reset to null when
	// consumed so a settings-page re-attempt doesn't see stale state.
	/** @type {null | {mutationID: number, status: string, reason?: string, message?: string}} */
	let lastOutcome = $state(null);

	$effect(() => {
		if (!session.hasLoaded || !workspaceId) return;

		const rep = initList({
			accountId: session.currentAccountId,
			listId: workspaceId,
			skipClientInit: true
		});
		workspaceData = rep.list;
		mutate = rep.mutate;

		const ws = initWebsocket(workspaceId, rep.client.clientID);
		ws.addEventListener('message', (event) => {
			const msg = decodeWSMessage(event.data);
			if (!msg) return;
			if (msg.type === 'poke') rep.client.pull();
			else if (msg.type === 'mutation_outcome') {
				lastOutcome = {
					mutationID: msg.mutationID,
					status: msg.status,
					reason: msg.reason,
					message: msg.message
				};
			}
		});

		return () => {
			rep.client.close();
			ws?.close(1000);
		};
	});

	/** @type {any} */
	const workspaceEntity = $derived(workspaceId ? workspaceData[workspaceId] : null);

	setContext(WORKSPACE_REPLICACHE_KEY, {
		get mutate() {
			return mutate;
		},
		get workspace() {
			return workspaceEntity;
		},
		get workspaceId() {
			return workspaceId;
		},
		get sessionWorkspace() {
			// Session-projected view (`{workspace, membership}`) — slug,
			// is_personal, projected role. The DO-resident
			// `workspaceEntity` above is authoritative on name +
			// authorization_rules; this is what surfaces session-level
			// projections like `membership.role` for header/nav UI.
			return current ?? null;
		},
		get lastOutcome() {
			return lastOutcome;
		},
		clearOutcome() {
			lastOutcome = null;
		}
	});
</script>

<div class="m-8">
	{#if current}
		<header class="mb-6">
			<h1 class="text-2xl">
				{workspaceEntity?.name ??
					current.workspace.name ??
					(current.workspace.is_personal ? 'Your space' : current.workspace.slug)}
			</h1>
			<nav class="flex gap-4 text-sm mt-1">
				<a href={`/w/${slug}`}>Home</a>
				<a href={`/w/${slug}/members`}>Members</a>
				<a href={`/w/${slug}/settings`}>Settings</a>
			</nav>
		</header>
		{@render children()}
	{:else}
		<p>Workspace not found in your session, or still loading…</p>
	{/if}
</div>
