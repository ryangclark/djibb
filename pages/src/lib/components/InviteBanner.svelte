<script>
	// @ts-check
	/**
	 * ADR 0009 Slice 3 — invitee-side accept surface.
	 *
	 * Renders on `/l/[id]` and `/t/[id]` when the URL carries
	 * `?from_invite=1` (the query string set by the invitation email).
	 * Fires the `acceptInvitation` mutator with the active account's
	 * verified email; the server-side mutator does the real
	 * identity-match check and resolves the rest. Failures
	 * (`gone` — invite revoked / expired / no match for this account,
	 * `auth` — identity-ownership preflight rejected) surface as
	 * toasts via the standard outcome channel.
	 *
	 * Display states:
	 *   - no session            → "Sign in to accept" + link to /accounts
	 *   - active account is
	 *     already a member      → "You already have access" + dismiss
	 *   - active account has
	 *     no verified email     → "Verify your email first" hint
	 *   - default               → "Accept invitation as <email>" button
	 *
	 * After a successful accept the entity's `authorization_rules`
	 * change to include the current account; the
	 * `alreadyAuthorized` derivation flips to true and the banner
	 * hides itself. On failure, the toast surfaces the reason and
	 * the user can dismiss manually.
	 */
	import { tryCatchAsync } from '$djibb/utils/trycatch';

	/**
	 * @typedef {Object} Props
	 * @property {string} entityId
	 * @property {'list' | 'template'} entityType
	 * @property {string | null} entityName  may be null pre-load
	 * @property {import('$djibb/auth/rules').AuthorizationRules | undefined} authorizationRules
	 * @property {import('$lib/replicache/types').ClientListMutators | undefined} mutators
	 * @property {readonly import('$djibb/account').Account[]} sessionAccounts
	 * @property {string | null} currentAccountId
	 * @property {string} pathname  current URL pathname (for sign-in `next=`)
	 */

	/** @type {Props} */
	let {
		entityId,
		entityType,
		entityName,
		authorizationRules,
		mutators,
		sessionAccounts,
		currentAccountId,
		pathname
	} = $props();

	// Local dismiss for already-a-member / post-success / explicit close.
	// Does not survive a refresh, but the `alreadyAuthorized` derivation
	// catches that case too.
	let dismissed = $state(false);

	let submitting = $state(false);

	let activeAccount = $derived(
		sessionAccounts.find(a => a.id === currentAccountId) ?? null
	);

	// Server demands a verified email — `preflightAcceptInvitation`
	// rejects unverified identity attempts with `identity_unverified`.
	// Surface the requirement up front rather than firing a doomed mutation.
	let activeEmail = $derived(
		activeAccount && activeAccount.email_verified
			? activeAccount.email
			: null
	);

	let alreadyAuthorized = $derived(
		authorizationRules && currentAccountId
			? authorizationRules.authorized_accounts[currentAccountId] != null
			: false
	);

	let visible = $derived(!dismissed && !alreadyAuthorized);

	async function accept() {
		if (!activeEmail || !mutators) return;
		submitting = true;
		const result = await tryCatchAsync(
			mutators.acceptInvitation({
				listId: entityId,
				identity_kind: 'email',
				identity_value: activeEmail
			})
		);
		submitting = false;
		if (result.error) {
			console.warn('acceptInvitation client mutator threw:', result.error);
			return;
		}
		// Optimistically dismiss. If the server rejects (gone / auth),
		// the outcome channel toasts; the user can re-open the email
		// link, switch accounts, etc.
		dismissed = true;
	}

	// `/accounts` doesn't currently honor a `next=` param across the
	// magic-link / OAuth sign-in flows — the user signs in there and
	// has to navigate back manually. Kept on the URL for future use;
	// dropping it would just be more code to undo when sign-in learns
	// to redirect.
	let signInHref = $derived(
		`/accounts?next=${encodeURIComponent(pathname + '?from_invite=1')}`
	);

	let entityLabel = $derived(entityType === 'template' ? 'template' : 'list');
	let displayName = $derived(entityName?.trim() || `this ${entityLabel}`);
</script>

{#if visible}
	<aside class="invite-banner" role="region" aria-label="Invitation">
		{#if sessionAccounts.length === 0}
			<p>
				You've been invited to <strong>{displayName}</strong>.
				<a href={signInHref}>Sign in to accept</a>.
			</p>
		{:else if !activeAccount}
			<p>
				You've been invited to <strong>{displayName}</strong>.
				Pick an account to continue.
				<a href={signInHref}>Manage accounts</a>.
			</p>
		{:else if !activeEmail}
			<p>
				You've been invited to <strong>{displayName}</strong>, but
				the active account ({activeAccount.display_name}) doesn't
				have a verified email. Verify it, or
				<a href={signInHref}>switch accounts</a>, to accept.
			</p>
		{:else}
			<div class="row">
				<p>
					You've been invited to
					<strong>{displayName}</strong>.
				</p>
				<div class="actions">
					<button
						type="button"
						class="primary"
						disabled={submitting}
						onclick={accept}
					>
						{submitting
							? 'Accepting…'
							: `Accept as ${activeEmail}`}
					</button>
					<button
						type="button"
						class="dismiss"
						onclick={() => (dismissed = true)}
						aria-label="Dismiss invitation banner"
					>
						Not now
					</button>
				</div>
				<p class="hint">
					Wrong account?
					<a href={signInHref}>Switch</a>
					and reload.
				</p>
			</div>
		{/if}
	</aside>
{/if}

<style>
	.invite-banner {
		border: 1px solid #c7d2fe;
		background: #eef2ff;
		color: #1e1b4b;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		margin: 0.75rem 0;
	}
	.invite-banner p {
		margin: 0;
	}
	.invite-banner .row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}
	.invite-banner .actions {
		display: flex;
		gap: 0.5rem;
	}
	.invite-banner .hint {
		flex-basis: 100%;
		color: #4338ca;
		font-size: 0.85rem;
	}
	.invite-banner button.primary {
		background: #4f46e5;
		color: white;
		border: none;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.invite-banner button.primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.invite-banner button.dismiss {
		background: transparent;
		border: 1px solid #a5b4fc;
		color: #1e1b4b;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.invite-banner a {
		color: #4338ca;
		text-decoration: underline;
	}
</style>
