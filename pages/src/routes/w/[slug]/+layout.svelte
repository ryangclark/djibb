<script>
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import { getSessionState } from '$lib/session.svelte';
	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';
	import { decodeWSMessage } from '$djibb/websocket/constants';
	import { resolveInvitedWorkspace } from '$lib/api/workspace';
	import InviteBanner from '$lib/components/InviteBanner.svelte';
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
		if (
			slug &&
			session.workspaces.length &&
			session.currentWorkspaceSlug !== slug
		) {
			session.setActiveWorkspace(slug);
		}
	});

	const current = $derived(
		session.workspaces.find((w) => w.workspace.slug === slug)
	);

	// ADR 0011 §Step 10d.3: pre-membership invite-accept branch. An
	// invitee following /w/<slug>?from_invite=1 isn't a member yet, so
	// `current` is undefined and the slug-keyed route can't get the
	// entity id from the session. Resolve slug -> id via the gated
	// endpoint (404 -> null when there's no pending invite) so we can
	// mount Replicache by id and show the accept banner.
	const fromInvite = $derived(page.url.searchParams.get('from_invite') === '1');

	let inviteResolved = $state(
		/** @type {{ id: string, name: string | null } | null} */ (null)
	);
	let inviteResolving = $state(false);

	$effect(() => {
		if (
			!fromInvite ||
			current ||
			!slug ||
			!session.hasLoaded ||
			!session.accounts.length
		) {
			inviteResolved = null;
			inviteResolving = false;
			return;
		}
		let cancelled = false;
		inviteResolving = true;
		resolveInvitedWorkspace(slug)
			.then((r) => {
				if (!cancelled) inviteResolved = r;
			})
			.catch(() => {
				if (!cancelled) inviteResolved = null;
			})
			.finally(() => {
				if (!cancelled) inviteResolving = false;
			});
		return () => {
			cancelled = true;
		};
	});

	// The id Replicache mounts against: the member's own workspace id, or
	// (invitee branch) the resolved id. Same value once the user accepts
	// and `current` resolves, so accepting doesn't re-mount the client.
	const workspaceId = $derived(
		current?.workspace.id ?? (fromInvite ? (inviteResolved?.id ?? null) : null)
	);

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
	const workspaceEntity = $derived(
		workspaceId ? workspaceData[workspaceId] : null
	);

	// ADR 0011 §Step 10d: surface the workspace DO's `pending_invites/*`
	// keyspace to child pages (members-page invite UI). The DO pull
	// filter only emits these rows to owners/admins, so non-managers see
	// an empty list regardless.
	/** @type {import('$lib/types/invites.js').PendingInvite[]} */
	const pendingInvites = $derived(
		Object.entries(workspaceData)
			.filter(([k]) => k.startsWith('pending_invites/'))
			.map(([, v]) => /** @type {any} */ (v))
	);

	// ADR 0011 §Step 10d.3: once acceptInvitation lands (the live entity
	// now grants the active account a role), pull the workspace into the
	// session so the normal member view replaces the accept banner.
	const inviteeBecameMember = $derived(
		fromInvite &&
			!current &&
			!!workspaceEntity &&
			!!session.currentAccountId &&
			workspaceEntity.authorization_rules?.authorized_accounts?.[
				session.currentAccountId
			] != null
	);

	$effect(() => {
		if (inviteeBecameMember) {
			void session.refreshWorkspaces();
		}
	});

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
		get pendingInvites() {
			return pendingInvites;
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
					(current.workspace.is_personal
						? 'Your space'
						: current.workspace.slug)}
			</h1>
			<nav class="flex gap-4 text-sm mt-1">
				<a href={`/w/${slug}`}>Home</a>
				<a href={`/w/${slug}/members`}>Members</a>
				<a href={`/w/${slug}/settings`}>Settings</a>
			</nav>
		</header>
		{@render children()}
	{:else if fromInvite && session.hasLoaded}
		<!-- ADR 0011 §Step 10d.3: pre-membership invite-accept surface.
		     Reachable before the invitee is a workspace member; on accept
		     `inviteeBecameMember` refreshes the session and the member
		     view above takes over. -->
		{#if inviteResolved}
			<header class="mb-6">
				<h1 class="text-2xl">
					{workspaceEntity?.name ?? inviteResolved.name ?? slug}
				</h1>
			</header>
			<InviteBanner
				entityId={inviteResolved.id}
				entityType="workspace"
				entityName={workspaceEntity?.name ?? inviteResolved.name ?? null}
				authorizationRules={workspaceEntity?.authorization_rules}
				mutators={mutate}
				sessionAccounts={session.accounts}
				currentAccountId={session.currentAccountId}
				pathname={page.url.pathname}
			/>
		{:else if inviteResolving}
			<p>Loading invitation…</p>
		{:else}
			<p>This invitation is no longer available, or you don't have access.</p>
		{/if}
	{:else}
		<p>Workspace not found in your session, or still loading…</p>
	{/if}
</div>
