<script>
	import { OAUTH_PROVIDER_PRETTY } from '@djibb/protocol/auth/constants';
	import { getSessionState, STATUSES } from '$lib/session.svelte';
	import { setAccountUsername } from '$lib/api/account';
	import { api, DjibbHttpError } from '$lib/api/client';
	import {
		discardUnflushed,
		UnflushedDiscardError
	} from '@djibb/client/unflushed';
	import { unflushedLedger } from '$lib/replicache/ledger.js';

	/**
	 * @type {{account: import("@djibb/protocol/account").Account}}
	 */
	const { account } = $props();

	const sessionState = getSessionState();
	let signingOut = $state(false);

	let editingUsername = $state(false);
	// Intentional one-time snapshot of the account's username as an
	// editable draft; it is not meant to track the prop reactively.
	// svelte-ignore state_referenced_locally
	let usernameDraft = $state(account.user_name ?? '');
	let savingUsername = $state(false);
	let usernameError = $state('');
	let usernameDetail = $state('');

	// Entities this account has work for that never reached the server
	// (GH #43). Signing out does NOT strand them — the ledger outlives
	// the session, so signing back in reopens the same store and the
	// queue flushes. But the user deserves to know before they walk
	// away from a browser, and to be able to say "no, throw it out".
	/** @type {string[]} */
	let stuckEntities = $state([]);
	let confirmingSignOut = $state(false);
	let discarding = $state(false);
	let signOutError = $state('');

	function handleSignOut() {
		if (signingOut) return;
		stuckEntities = unflushedLedger.entitiesFor(account.id);
		if (stuckEntities.length > 0) {
			// Don't surprise anyone: unsaved work turns sign-out into a
			// decision rather than a button.
			confirmingSignOut = true;
			return;
		}
		void signOut();
	}

	/**
	 * @param {{ discard?: boolean }} [opts]
	 */
	async function signOut({ discard = false } = {}) {
		if (signingOut) return;
		signingOut = true;
		confirmingSignOut = false;

		signOutError = '';

		try {
			// Sign out FIRST, discard second — the order is load-bearing.
			// Discarding is irreversible, and this request is exactly the
			// one that fails when the user is offline, which is exactly
			// when they have unflushed work in the first place. Discarding
			// up front would destroy their changes and then leave them
			// still signed in when the request threw: the worst of both.
			//
			// 204 when the account wasn't on the session; a re-minted session
			// JSON otherwise. Either way there's nothing here to read.
			await api.del('/auth/session/accounts', {
				json: { account_id: account.id }
			});

			if (discard) {
				// Deliberately more than a ledger delete: dropping only the
				// claim would leave the mutations rotting in an IndexedDB
				// store nothing will ever open again. If the user says
				// discard, actually discard.
				discarding = true;
				await discardUnflushed({
					ledger: unflushedLedger,
					accountId: account.id
				});
				discarding = false;
			}

			if (sessionState.status === STATUSES.idle) {
				await sessionState.fetchSession();
			}
		} catch (err) {
			// This is the one place in the flow where the user made an
			// irreversible decision, so a failure here cannot be a silent
			// console line: they were shown "Removing…" and would otherwise
			// walk away believing the changes are gone when they aren't.
			if (err instanceof UnflushedDiscardError) {
				signOutError =
					'Signed out, but some unsaved changes could not be removed — ' +
					'another tab may still have this list open. Close it and try again.';
				console.error('Discard failed:', err.blocked);
			} else if (err instanceof DjibbHttpError) {
				signOutError = `Sign-out failed (${err.status}). Nothing was changed.`;
				console.error('Sign-out failed:', err.status);
			} else {
				signOutError = 'Sign-out failed. Nothing was changed.';
				console.error('Sign-out error:', err);
			}
		}

		discarding = false;
		signingOut = false;
	}

	function startEdit() {
		usernameDraft = account.user_name ?? '';
		usernameError = '';
		usernameDetail = '';
		editingUsername = true;
	}

	function cancelEdit() {
		editingUsername = false;
		usernameError = '';
	}

	async function saveUsername() {
		const next = usernameDraft.trim();
		if (!next) {
			usernameError = 'Username cannot be empty.';
			return;
		}
		savingUsername = true;
		usernameError = '';
		try {
			const result = await setAccountUsername(account.id, next);
			usernameDetail = result.detail;
			editingUsername = false;
			// Refresh session so the new user_name is visible everywhere.
			if (sessionState.status === STATUSES.idle) {
				await sessionState.fetchSession();
			}
		} catch (e) {
			usernameError = /** @type {Error} */ (e).message ?? String(e);
		} finally {
			savingUsername = false;
		}
	}
</script>

<div class="flex gap-4 items-center">
	<!-- UPGRADE: create a backup avatar img -->
	<img alt="account flag" src={account.image || ''} />

	<div class="flex-1">
		{#if account.provider_name}
			<p class="text-stone-500 text-sm">
				{OAUTH_PROVIDER_PRETTY[account.provider_name] || account.provider_name}
			</p>
		{/if}
		<h3 class="text-lg">
			{#if account.display_name}
				{account.display_name}
			{:else}
				<span class="italic">nameless</span>
			{/if}
		</h3>
		{#if account.email}
			<!-- UPGRADE: Make email click-to-copy -->
			<p>{account.email}</p>
			<!-- UPGRADE: indicate whether email is verified, and allow start of verification flow if available -->
		{/if}

		<div class="mt-2 text-sm">
			{#if editingUsername}
				<div class="flex items-center gap-2">
					<span class="text-stone-500">@</span>
					<input
						class="border px-2 py-1 text-sm font-mono"
						bind:value={usernameDraft}
						placeholder="alice"
						disabled={savingUsername}
					/>
					<button
						class="border px-2 py-1 text-xs"
						onclick={saveUsername}
						disabled={savingUsername}
					>
						{savingUsername ? 'Saving…' : 'Save'}
					</button>
					<button
						class="text-xs text-stone-500"
						onclick={cancelEdit}
						disabled={savingUsername}>Cancel</button
					>
				</div>
				{#if usernameError}
					<p class="text-red-600 text-xs mt-1">{usernameError}</p>
				{/if}
			{:else if account.user_name}
				<div class="flex items-center gap-2">
					<span class="font-mono">@{account.user_name}</span>
					<button class="text-xs text-stone-500 underline" onclick={startEdit}>
						Change
					</button>
				</div>
				{#if usernameDetail}
					<p class="text-xs text-stone-500 mt-1">{usernameDetail}</p>
				{/if}
			{:else}
				<button class="text-xs text-stone-500 underline" onclick={startEdit}>
					Claim a username
				</button>
				<p class="text-xs text-stone-500">
					Optional. Lets others invite you to workspaces by name and find you at /u/&lt;username&gt;.
				</p>
			{/if}
		</div>
	</div>

	<button
		class="p-2 border border-stone-900 disabled:opacity-50"
		disabled={signingOut}
		onclick={handleSignOut}
	>
		{signingOut ? 'Signing out...' : 'Sign out'}
	</button>
</div>

{#if signOutError}
	<p class="signout-error" role="alert">{signOutError}</p>
{/if}

{#if confirmingSignOut}
	<div class="unsynced-confirm" role="alertdialog" aria-label="Unsaved changes">
		<p>
			<strong
				>{stuckEntities.length}
				{stuckEntities.length === 1 ? 'list has' : 'lists have'} unsaved changes</strong
			>
			that haven't reached the server yet.
		</p>
		<!-- Lead with the reassuring truth: signing out is not
		     destructive here. The queue outlives the session, so this is
		     a "come back and finish" state, not a "lose your work" one. -->
		<p class="hint">
			They're kept on this device. Sign back in as this account and they'll
			finish saving on their own.
		</p>
		<div class="actions">
			<button
				type="button"
				class="primary"
				disabled={signingOut}
				onclick={() => signOut()}
			>
				Sign out, keep changes
			</button>
			<button
				type="button"
				class="danger"
				disabled={signingOut}
				onclick={() => signOut({ discard: true })}
			>
				{discarding ? 'Removing…' : 'Sign out and remove unsaved changes'}
			</button>
			<button
				type="button"
				class="cancel"
				disabled={signingOut}
				onclick={() => (confirmingSignOut = false)}
			>
				Cancel
			</button>
		</div>
		<p class="hint danger-hint">
			Removing can't be undone — those changes exist nowhere else.
		</p>
	</div>
{/if}

<style>
	.signout-error {
		border: 1px solid #fecaca;
		background: #fef2f2;
		color: #7f1d1d;
		padding: 0.5rem 0.75rem;
		border-radius: 0.35rem;
		margin: 0.5rem 0;
		font-size: 0.9rem;
	}
	.unsynced-confirm {
		border: 1px solid #fed7aa;
		background: #fff7ed;
		color: #7c2d12;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		margin: 0.5rem 0 1rem;
	}
	.unsynced-confirm p {
		margin: 0 0 0.5rem;
	}
	.unsynced-confirm .hint {
		font-size: 0.85rem;
		color: #9a3412;
	}
	.unsynced-confirm .actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0 0.5rem;
	}
	.unsynced-confirm button {
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.unsynced-confirm button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.unsynced-confirm button.primary {
		background: #9a3412;
		color: white;
		border: none;
	}
	.unsynced-confirm button.danger {
		background: transparent;
		border: 1px solid #dc2626;
		color: #b91c1c;
	}
	.unsynced-confirm button.cancel {
		background: transparent;
		border: 1px solid #d6d3d1;
		color: #57534e;
	}
	.unsynced-confirm .danger-hint {
		margin: 0;
		font-size: 0.8rem;
	}
</style>
