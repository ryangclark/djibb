<script>
	// @ts-check
	/**
	 * ADR 0009 — shared invite surface for any DjibbList-shaped entity
	 * (List, Template, Workspace). Carries two sections:
	 *
	 *   1. "Invite by email" — fires `inviteByIdentity` through the
	 *      passed mutator proxy. Server-side preflight (rate limit,
	 *      outstanding cap, already-a-member, self-invite) runs in the
	 *      DO push handler; failures surface over the WS outcome channel
	 *      as toasts, not as thrown errors here.
	 *   2. "Pending invitations" — the live `pending_invites/*` rows
	 *      (owner/admin-gated by the pull filter), each with a Revoke
	 *      affordance wired to `revokeInvitation`.
	 *
	 * Extracted from `Share.svelte` (ADR 0011 §Step 10d) so the
	 * workspace members page can reuse the exact same flow — workspaces
	 * are DjibbLists, so `inviteByIdentity` / `revokeInvitation` already
	 * work against the workspace DO unchanged.
	 *
	 * Caller is responsible for gating: only render this when the active
	 * account may manage the entity (owner/admin). The component does no
	 * role check of its own.
	 */
	import { tryCatchAsync } from '$djibb/utils/trycatch';

	const ROLE_LABELS = /** @type {const} */ ({
		owner: 'Owner',
		admin: 'Admin',
		editor: 'Editor',
		checker: 'Checker',
		viewer: 'Viewer'
	});

	/** @typedef {import('$lib/types/invites.js').PendingInvite} PendingInvite */

	/**
	 * @typedef {Object} Props
	 * @property {string} entityId  prefixed id, e.g. "l/…", "w/…"
	 * @property {import('$lib/replicache/types').ClientListMutators} mutators
	 * @property {string | null} currentAccountId
	 * @property {PendingInvite[]} [pendingInvites]
	 *   Live pending invitations, surfaced by the `pending_invites/*`
	 *   Replicache keyspace. Visible only to owners/admins per the
	 *   role-gated pull filter; the route filters `list_data` for keys
	 *   beginning with `pending_invites/`.
	 * @property {readonly import('@djibb/protocol/auth/rules').InvitableRole[]} [assignableRoles]
	 *   Roles offerable on an invite. Defaults to the full *invitable*
	 *   set, which excludes `owner`: ownership is transferred via
	 *   `transferOwnership`, never invited (single-owner invariant).
	 *   Workspaces narrow it further (no `checker` — not a workspace
	 *   role).
	 */

	/** @type {Props} */
	let {
		entityId,
		mutators,
		currentAccountId,
		pendingInvites = [],
		assignableRoles = ['admin', 'editor', 'checker', 'viewer']
	} = $props();

	// ADR 0009 Slice 3 — invite-by-email form. Local "Invitation sent"
	// feedback is optimistic; the matching pending_invite row appears
	// under the section below on the next pull (driven by the
	// post-commit poke, <1s).
	let inviteEmail = $state('');
	// Default the role picker from the assignable set at open time; a
	// one-time snapshot, not a reactive mirror of the prop.
	// svelte-ignore state_referenced_locally
	let inviteRole = $state(
		/** @type {import('@djibb/protocol/auth/rules').InvitableRole} */ (
			assignableRoles.includes('editor') ? 'editor' : assignableRoles[0]
		)
	);
	let inviteSubmitting = $state(false);
	let inviteSentAt = $state(/** @type {number | null} */ (null));
	let inviteLocalError = $state(/** @type {string | null} */ (null));

	async function sendInvite() {
		inviteLocalError = null;
		inviteSentAt = null;
		const email = inviteEmail.trim();
		if (!email) {
			inviteLocalError = 'Enter an email address.';
			return;
		}
		if (!currentAccountId) {
			inviteLocalError = 'Sign in to send invitations.';
			return;
		}
		inviteSubmitting = true;
		const result = await tryCatchAsync(
			mutators.inviteByIdentity({
				listId: entityId,
				identity_kind: 'email',
				identity_value: email,
				role: inviteRole
			})
		);
		inviteSubmitting = false;

		if (result.error) {
			// Client-side mutator threw — rare (NotFoundError on
			// `tx.get(listId)` or similar). Server-side preflight
			// failures flow through the WS outcome channel + global toast.
			inviteLocalError = `Failed to send: ${result.error.message ?? result.error}`;
			return;
		}
		inviteEmail = '';
		inviteSentAt = Date.now();
	}

	// Pending-invitation revoke flow. Goes through the standard
	// Replicache push; failures flow back through the outcome channel.
	let revoking = $state(/** @type {Set<string>} */ (new Set()));
	let revokeError = $state(/** @type {string | null} */ (null));

	let pendingInviteRows = $derived(
		(pendingInvites ?? [])
			.slice()
			.sort((a, b) => a.time_created - b.time_created)
	);

	/** @param {PendingInvite} invite */
	async function revoke(invite) {
		revokeError = null;
		const key = `${invite.identity_kind}|${invite.identity_value}`;
		if (revoking.has(key)) return;
		revoking.add(key);
		revoking = new Set(revoking);

		const result = await tryCatchAsync(
			mutators.revokeInvitation({
				listId: entityId,
				identity_kind: invite.identity_kind,
				identity_value: invite.identity_value
			})
		);

		revoking.delete(key);
		revoking = new Set(revoking);

		if (result.error) {
			revokeError = `Failed to revoke: ${result.error.message ?? result.error}`;
		}
	}

	/**
	 * Format unix seconds as a glanceable expiry label. Cheap; no date
	 * library.
	 * @param {number} timeExpiresSeconds
	 */
	function expiryLabel(timeExpiresSeconds) {
		const nowSec = Math.floor(Date.now() / 1000);
		const deltaSec = timeExpiresSeconds - nowSec;
		if (deltaSec <= 0) return 'expired';
		const days = Math.floor(deltaSec / 86400);
		if (days >= 2) return `expires in ${days} days`;
		if (days === 1) return 'expires tomorrow';
		const hours = Math.floor(deltaSec / 3600);
		if (hours >= 2) return `expires in ${hours}h`;
		if (hours === 1) return 'expires in 1h';
		return 'expires soon';
	}
</script>

<section>
	<h2>Invite by email</h2>
	<form
		class="invite-form"
		onsubmit={(e) => {
			e.preventDefault();
			void sendInvite();
		}}
	>
		<div class="invite-row">
			<input
				id="invite-email-input"
				type="email"
				placeholder="name@example.com"
				bind:value={inviteEmail}
				disabled={inviteSubmitting}
				autocomplete="email"
				aria-label="Invite by email"
			/>
			<select
				bind:value={inviteRole}
				disabled={inviteSubmitting}
				aria-label="Role"
			>
				{#each assignableRoles as r (r)}
					<option value={r}>{ROLE_LABELS[r]}</option>
				{/each}
			</select>
			<button
				type="submit"
				class="primary"
				disabled={inviteSubmitting || !inviteEmail.trim()}
			>
				{inviteSubmitting ? 'Sending…' : 'Send invite'}
			</button>
		</div>
		{#if inviteLocalError}
			<p class="error" role="alert">{inviteLocalError}</p>
		{/if}
		{#if inviteSentAt}
			<p class="saved" role="status">
				Invitation sent. It'll appear under "Pending invitations" shortly.
				Server-side rejections (rate limit, already a member, …) surface as
				toasts.
			</p>
		{/if}
	</form>
</section>

<section>
	<h2>Pending invitations</h2>
	{#if pendingInviteRows.length === 0}
		<p class="hint">
			No invitations are currently pending. Once you send one, it'll appear here
			until the recipient accepts it or you revoke it.
		</p>
	{:else}
		<ul class="account-list">
			{#each pendingInviteRows as invite (`${invite.identity_kind}|${invite.identity_value}`)}
				{@const key = `${invite.identity_kind}|${invite.identity_value}`}
				{@const isExpired = invite.time_expires < Math.floor(Date.now() / 1000)}
				<li>
					<span class="account-id">
						<code>{invite.identity_value}</code>
						<span class="role-badge">
							{ROLE_LABELS[invite.role] ?? invite.role}
						</span>
						<span class="expiry" class:expired={isExpired}>
							{expiryLabel(invite.time_expires)}
						</span>
					</span>
					<span class="placeholder-cell"></span>
					<button
						type="button"
						class="remove"
						disabled={revoking.has(key)}
						onclick={() => revoke(invite)}
					>
						{revoking.has(key) ? 'Revoking…' : 'Revoke'}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if revokeError}
		<p class="error" role="alert">{revokeError}</p>
	{/if}
</section>

<style>
	section {
		margin: 1.5rem 0;
		padding: 1rem;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 0.5rem;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem 0;
	}
	.hint {
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
		opacity: 0.7;
	}
	.account-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.account-list li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0;
		border-bottom: 1px solid rgba(0, 0, 0, 0.06);
	}
	.account-list li:last-child {
		border-bottom: none;
	}
	.account-id code {
		font-size: 0.8rem;
		word-break: break-all;
	}
	.role-badge {
		margin-left: 0.4rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.06);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.expiry {
		margin-left: 0.4rem;
		font-size: 0.75rem;
		opacity: 0.6;
	}
	.expiry.expired {
		color: rgb(160, 0, 0);
		opacity: 1;
	}
	.placeholder-cell {
		display: inline-block;
	}
	.invite-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.5rem;
		align-items: center;
	}
	.invite-row input[type='email'] {
		padding: 0.4rem 0.6rem;
		border: 1px solid rgba(0, 0, 0, 0.18);
		border-radius: 0.25rem;
		font-size: 0.95rem;
	}
	.invite-row select {
		padding: 0.4rem;
		border-radius: 0.25rem;
	}
	.remove {
		background: transparent;
		border: 1px solid rgba(200, 0, 0, 0.3);
		color: rgb(160, 0, 0);
		border-radius: 0.25rem;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}
	.remove:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button {
		padding: 0.5rem 1rem;
		border-radius: 0.25rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		background: white;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button.primary {
		background: rgb(0, 100, 200);
		color: white;
		border-color: rgb(0, 100, 200);
	}
	button.primary:disabled {
		background: rgba(0, 100, 200, 0.4);
	}
	.error {
		color: rgb(160, 0, 0);
		margin: 0.5rem 0;
	}
	.saved {
		color: rgb(0, 120, 60);
		margin: 0.5rem 0;
	}
</style>
