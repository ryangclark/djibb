<script>
	// @ts-check
	/**
	 * ADR 0009 §Recipient discovery — the canonical `/invitations` inbox.
	 * The other half of dual-surface discovery (the entity-page
	 * `InviteBanner` is the first); this covers the lost-the-email case by
	 * listing every pending invite addressed to the session's accounts.
	 *
	 * Accept is not performed here. `acceptInvitation` is a per-entity
	 * Replicache DO mutator that needs the entity mounted, so each row
	 * links to the entity's accept surface (`?from_invite=1`), where the
	 * existing `InviteBanner` drives the accept. Keeps one accept code
	 * path instead of re-mounting Replicache per inbox row.
	 */
	import { getSessionState } from '$lib/session.svelte';
	import { fetchInvitationsForAccount } from '$lib/api/invitations';

	const session = getSessionState();

	/** @type {Map<string, import('$lib/api/invitations').PendingInvitation[]>} */
	let invitesByAccount = $state(new Map());
	let loading = $state(false);
	let error = $state('');

	async function loadAll() {
		if (!session.accounts.length) {
			invitesByAccount = new Map();
			return;
		}
		loading = true;
		error = '';
		try {
			const entries = await Promise.all(
				session.accounts.map(async (a) => {
					try {
						const rows = await fetchInvitationsForAccount(a.id);
						return /** @type {[string, import('$lib/api/invitations').PendingInvitation[]]} */ ([
							a.id,
							rows
						]);
					} catch {
						return /** @type {[string, import('$lib/api/invitations').PendingInvitation[]]} */ ([
							a.id,
							[]
						]);
					}
				})
			);
			invitesByAccount = new Map(entries);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		loading = false;
	}

	$effect(() => {
		if (session.hasLoaded) {
			void loadAll();
		}
	});

	/**
	 * The entity's accept surface. Lists/templates URL by id; workspaces
	 * URL by slug (the not-yet-member route resolves the id behind a
	 * pending-invite gate, ADR 0011 §10d.3). `?from_invite=1` tells the
	 * page to render the `InviteBanner`.
	 * @param {import('$lib/api/invitations').PendingInvitation} inv
	 */
	function acceptHref(inv) {
		if (inv.target_type === 'workspace') {
			return `/w/${inv.slug}?from_invite=1`;
		}
		const prefix = inv.target_type === 'template' ? 't' : 'l';
		return `/${prefix}/${inv.target_id}?from_invite=1`;
	}

	/** @param {import('$lib/api/invitations').PendingInvitation} inv */
	function displayName(inv) {
		return inv.name && inv.name.trim()
			? inv.name
			: `(unnamed ${inv.target_type})`;
	}

	/**
	 * Coarse "expires in" string from a unix-seconds deadline. Blunt is
	 * fine — the inbox is a recovery surface, not a countdown.
	 * @param {number} seconds
	 */
	function expiresIn(seconds) {
		const diff = seconds * 1000 - Date.now();
		if (diff <= 0) return 'expired';
		const days = Math.floor(diff / 86_400_000);
		if (days >= 1) return `expires in ${days}d`;
		const hours = Math.floor(diff / 3_600_000);
		if (hours >= 1) return `expires in ${hours}h`;
		return 'expires soon';
	}

	/** @param {{ id: string, display_name?: string|null }} a */
	function accountLabel(a) {
		return a.display_name?.trim() || a.id;
	}

	const totalCount = $derived(
		Array.from(invitesByAccount.values()).reduce((n, rs) => n + rs.length, 0)
	);
</script>

<h1 class="text-2xl mb-2">Invitations</h1>

{#if !session.accounts.length}
	<p>Sign in to see your invitations.</p>
{:else if loading && !invitesByAccount.size}
	<p class="text-sm text-stone-500">Loading…</p>
{:else if totalCount === 0}
	<p><i>No pending invitations.</i></p>
	<p class="text-sm text-stone-500 mt-2">
		When someone invites you to a list, template, or workspace, it shows up here
		— even if you can't find the email.
	</p>
{:else}
	<p class="text-sm text-stone-500 mb-4">
		Invitations addressed to your verified email. Open one to accept it.
	</p>
	{#each session.accounts as account (account.id)}
		{@const rows = invitesByAccount.get(account.id) ?? []}
		{#if rows.length}
			<section class="mb-6">
				{#if session.accounts.length > 1}
					<h2 class="text-sm uppercase tracking-wide text-stone-500 mb-2">
						{accountLabel(account)}
					</h2>
				{/if}
				<ul>
					{#each rows as inv (inv.id)}
						<li class="my-2 flex items-center gap-3">
							<span class="flex-1">
								<span class="font-medium">{displayName(inv)}</span>
								<span class="text-xs text-stone-500 ml-2">
									{inv.target_type} · invited as {inv.role} · {expiresIn(
										inv.time_expires
									)}
								</span>
							</span>
							<a class="border px-3 py-1 text-sm" href={acceptHref(inv)}>
								View &amp; accept
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
{/if}

{#if error}
	<p class="text-red-600 text-sm mt-4">{error}</p>
{/if}
