<script>
	// Workspace audit log (Phase 5 polish). Owner/admin-only view of the
	// workspace DO's mutation history — invitations, membership changes,
	// renames, moves, cascade events. Reads the gated `/workspace/audit`
	// endpoint (the server returns 403 for non-managers; we also hide the
	// surface in the UI). Data is the per-entity `mutations` table, not a
	// Replicache subscription — an append-only log is fetched on demand
	// and paginated, not synced into reactive state.
	import { getContext, untrack } from 'svelte';
	import { getSessionState } from '$lib/session.svelte';
	import { WORKSPACE_REPLICACHE_KEY } from '../_context.js';
	import { fetchWorkspaceAudit } from '$lib/api/audit.js';

	const session = getSessionState();
	/** @type {any} */
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);

	const workspaceId = $derived(ctx?.workspaceId ?? null);
	const role = $derived(ctx?.sessionWorkspace?.membership?.role ?? null);
	const canView = $derived(role === 'owner' || role === 'admin');

	/** @type {import('$lib/api/audit.js').AuditEntry[]} */
	let entries = $state([]);
	/** @type {Record<string, string|null>} */
	let credentialLabels = $state({});
	/** @type {number | null} */
	let nextBefore = $state(null);
	let loading = $state(false);
	let loaded = $state(false);
	/** @type {string | null} */
	let error = $state(null);

	// Human-readable labels for the mutator names that land in a
	// workspace's log. Unmapped names fall back to the raw name so a new
	// mutator still shows something sensible rather than disappearing.
	/** @type {Record<string, string>} */
	const ACTION_LABELS = {
		createWorkspace: 'Created the workspace',
		renameWorkspace: 'Renamed the workspace',
		setWorkspaceSlug: 'Changed the workspace URL',
		setWorkspaceImage: 'Changed the workspace image',
		inviteByIdentity: 'Invited a member',
		revokeInvitation: 'Revoked an invitation',
		acceptInvitation: 'Accepted an invitation',
		changeMemberRole: 'Changed a member’s role',
		removeMember: 'Removed a member',
		leaveMember: 'Left the workspace',
		transferOwnership: 'Transferred ownership',
		moveList: 'Moved a list',
		archiveList: 'Archived an entity',
		cascadeRestoreList: 'Restored an entity',
		startFresh: 'Emptied the workspace'
	};

	/** @param {import('$lib/api/audit.js').AuditEntry} e */
	function label(e) {
		return ACTION_LABELS[e.name] ?? e.name;
	}

	/** @param {number | null} ts unix seconds */
	function when(ts) {
		if (ts == null) return '—';
		return new Date(ts * 1000).toLocaleString();
	}

	/**
	 * Attribution label for a token-authored entry (ADR 0022 §5, #24):
	 * "via <label>", falling back to the bare credential id when the token
	 * was minted without one. Returns null for interactive (session) entries.
	 * @param {import('$lib/api/audit.js').AuditEntry} e
	 */
	function via(e) {
		if (!e.credential_id) return null;
		return credentialLabels[e.credential_id] ?? e.credential_id;
	}

	/** @param {string | null} accountId */
	function actor(accountId) {
		if (!accountId) return 'System';
		if (accountId === session.currentAccountId) return 'You';
		// No display-name lookup yet — show the id suffix, which is at
		// least stable and distinguishable. (Resolving to display names is
		// a follow-up; the members projection isn't loaded on this route.)
		const suffix = accountId.split('/', 2)[1] ?? accountId;
		return suffix.slice(0, 8) + '…';
	}

	async function load(
		/** @type {{ older?: boolean }} */ { older = false } = {}
	) {
		if (!workspaceId || loading) return;
		loading = true;
		error = null;
		try {
			const page = await fetchWorkspaceAudit({
				workspaceId,
				accountId: session.currentAccountId,
				before: older ? nextBefore : null
			});
			entries = older ? [...entries, ...page.entries] : page.entries;
			credentialLabels = older
				? { ...credentialLabels, ...page.credentialLabels }
				: page.credentialLabels;
			nextBefore = page.nextBefore;
			loaded = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		loading = false;
	}

	// Fetch a fresh first page whenever the managing role + workspace id
	// become known (or the workspace changes under the route). `untrack`
	// keeps `load`'s internal reads (`loading`, `workspaceId`) out of the
	// effect's dependency set — without it, toggling `loading` would
	// re-trigger the effect and storm the endpoint.
	$effect(() => {
		if (canView && workspaceId) untrack(() => void load());
	});
</script>

<section>
	<h2 class="text-xl mb-4">Audit log</h2>

	{#if !canView}
		<p class="text-sm text-stone-500">
			Only workspace owners and admins can view the audit log.
		</p>
	{:else if error}
		<p class="text-sm text-red-600">Couldn’t load the audit log: {error}</p>
		<button class="border px-3 py-1 mt-2 text-sm" onclick={() => load()}>
			Retry
		</button>
	{:else if loaded && entries.length === 0}
		<p class="text-sm text-stone-500">No activity recorded yet.</p>
	{:else}
		<ul class="divide-y">
			{#each entries as entry (entry.client_id + ':' + entry.id)}
				<li class="py-2 flex items-baseline gap-3">
					<span class="text-sm">
						<strong>{actor(entry.account_id)}</strong>
						{label(entry)}
						{#if via(entry)}
							<span class="text-stone-500">· via {via(entry)}</span>
						{/if}
						{#if entry.status !== 'succeeded'}
							<span class="text-xs text-amber-700">({entry.status})</span>
						{/if}
					</span>
					<span class="text-xs text-stone-500 ml-auto whitespace-nowrap">
						{when(entry.timestamp_server)}
					</span>
				</li>
			{/each}
		</ul>

		{#if nextBefore != null}
			<button
				class="border px-3 py-1 mt-4 text-sm"
				disabled={loading}
				onclick={() => load({ older: true })}
			>
				{loading ? 'Loading…' : 'Load older'}
			</button>
		{:else if loading}
			<p class="text-sm text-stone-500 mt-4">Loading…</p>
		{/if}
	{/if}
</section>
