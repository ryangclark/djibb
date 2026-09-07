<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { OAUTH_PROVIDER_PRETTY } from '@djibb/protocol/auth/constants';
	import { getSessionState, STATUSES } from '$lib/session.svelte';
	import {
		setAccountUsername,
		requestSudo,
		deleteAccount,
		SudoRequiredError
	} from '$lib/api/account';
	import { api, DjibbHttpError } from '$lib/api/client';
	import {
		discardUnflushed,
		probeUnflushed,
		UnflushedDiscardError
	} from '@djibb/client/unflushed';
	import { mutators } from '@djibb/protocol/list/mutators/client';
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

	// Does the user still have another account here after this sign-out?
	// It changes what we can honestly promise (GH #46). "Sign back in and
	// they'll finish saving on their own" is true on an empty session —
	// signing back in makes this account current, the store reopens, the
	// queue drains. It is NOT true while another account remains: the
	// current account is workspace-derived, so the session keeps offering
	// the *other* one, we keep opening its store, and this account's work
	// keeps sitting there untouched. Promising otherwise would be exactly
	// the reassurance-over-stranded-work this whole area exists to remove.
	let otherAccountsRemain = $derived(
		sessionState.accounts.some((a) => a.id !== account.id)
	);

	async function handleSignOut() {
		if (signingOut) return;

		// The ledger is an index of stores worth opening, not an answer: a
		// claim is stamped before its mutation fires and can outlive it. So
		// don't turn sign-out into a decision on the strength of a claim —
		// open each store and count what's actually in it. A prompt that
		// warns about work that isn't there trains people to click through
		// the one time it is.
		//
		// A store we cannot read is treated as stuck (the `catch`): warning
		// about work that might not exist is recoverable; skipping the
		// prompt for work that does is not.
		signingOut = true;
		try {
			const claimed = unflushedLedger.entitiesFor(account.id);
			/** @type {string[]} */
			const confirmed = [];
			for (const entityId of claimed) {
				try {
					const count = await probeUnflushed({
						accountId: account.id,
						entityId,
						mutators
					});
					if (count > 0) confirmed.push(entityId);
				} catch (err) {
					console.error('Could not probe unflushed work:', entityId, err);
					confirmed.push(entityId);
				}
			}
			stuckEntities = confirmed;
		} finally {
			signingOut = false;
		}

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

	// --- Danger zone: delete this identity (GH #58, ADR 0024 §3 exit path) ---
	//
	// A destructive, GitHub-style flow: a client "type delete" speed-bump, then
	// a real sudo step-up (a magic-link re-auth that lands back here with
	// `?sudo=ok`), then the irreversible confirm. Deletion is Phase 1 — the
	// account is soft-deleted and every session/credential/pending-auth for it
	// is revoked immediately (signed out everywhere), with the scheduled PII
	// purge deferred to Phase 2.
	//
	// Stages: 'idle' → 'confirm' (typed speed-bump) → 'requesting' →
	// 'awaiting-sudo' (email sent) → 'ready' (sudo-fresh, back from the link) →
	// 'deleting'.
	let dangerOpen = $state(false);
	let deleteStage = $state('idle');
	let deleteConfirmText = $state('');
	let deleteError = $state('');
	// The sudo step-up redirects the whole browser, so which account was being
	// deleted can't live in memory across it — park it here, keyed per account.
	const PENDING_DELETE_KEY = 'djibb.pendingDeleteAccount';
	// Dev-only: the `_dev` seam hands back the magic-link URL so a local
	// walk-through can skip the inbox. Never populated in production.
	let devLandingUrl = $state('');

	onMount(() => {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams(window.location.search);
		if (params.get('sudo') !== 'ok') return;
		// Only the row whose pending id matches the completed step-up unlocks —
		// the sudo stamp is account-precise on the server, so the UI must be too.
		const pending = sessionStorage.getItem(PENDING_DELETE_KEY);
		if (pending !== account.id) return;
		dangerOpen = true;
		deleteStage = 'ready';
		// Strip `?sudo=ok` so a refresh doesn't re-open the confirm state.
		params.delete('sudo');
		const qs = params.toString();
		history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
	});

	function openDanger() {
		dangerOpen = true;
		deleteStage = 'confirm';
		deleteConfirmText = '';
		deleteError = '';
	}

	function cancelDelete() {
		dangerOpen = false;
		deleteStage = 'idle';
		deleteConfirmText = '';
		deleteError = '';
		devLandingUrl = '';
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.removeItem(PENDING_DELETE_KEY);
		}
	}

	async function startSudo() {
		if (deleteConfirmText.trim().toLowerCase() !== 'delete') {
			deleteError = 'Type "delete" to continue.';
			return;
		}
		deleteError = '';
		deleteStage = 'requesting';
		try {
			// Park the target BEFORE the redirect: consuming the emailed link
			// reloads this page, and this is how the returning row knows it's the
			// one to unlock.
			sessionStorage.setItem(PENDING_DELETE_KEY, account.id);
			const { landingUrl } = await requestSudo(account.id);
			devLandingUrl = landingUrl ?? '';
			deleteStage = 'awaiting-sudo';
		} catch (err) {
			deleteError = /** @type {Error} */ (err).message ?? String(err);
			deleteStage = 'confirm';
		}
	}

	async function confirmDelete() {
		deleteError = '';
		deleteStage = 'deleting';
		try {
			const { signedOut } = await deleteAccount(account.id);
			if (typeof sessionStorage !== 'undefined') {
				sessionStorage.removeItem(PENDING_DELETE_KEY);
			}
			if (signedOut) {
				// The whole session was this one account — its cookie is cleared.
				// Leave the app for a plain goodbye rather than snapping back to a
				// signed-out /accounts.
				await goto('/goodbye');
				return;
			}
			// A multi-account session survives; refresh so this row drops out and
			// the switcher re-hydrates without the deleted identity.
			if (sessionState.status === STATUSES.idle) {
				await sessionState.fetchSession();
			}
		} catch (err) {
			if (err instanceof SudoRequiredError) {
				// The stamp went stale (the 5-minute window elapsed) or never
				// landed. Send them back through the step-up, not to a dead end.
				deleteError =
					'Your verification expired. Please confirm again to delete this account.';
				deleteStage = 'confirm';
				deleteConfirmText = '';
				if (typeof sessionStorage !== 'undefined') {
					sessionStorage.removeItem(PENDING_DELETE_KEY);
				}
			} else {
				deleteError = /** @type {Error} */ (err).message ?? String(err);
				deleteStage = 'ready';
			}
		}
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
		     a "come back and finish" state, not a "lose your work" one.
		     But keep the reassurance inside what's actually guaranteed —
		     see `otherAccountsRemain`. -->
		{#if otherAccountsRemain}
			<p class="hint">
				They're kept on this device. Because you're still signed in to another
				account, djibb will keep working as that one — so these changes stay
				put until you make this account current again. Any list they're on will
				say so.
			</p>
		{:else}
			<p class="hint">
				They're kept on this device. Sign back in as this account and they'll
				finish saving on their own.
			</p>
		{/if}
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

<section class="danger-zone">
	{#if !dangerOpen}
		<button type="button" class="danger-toggle" onclick={openDanger}>
			Delete this account
		</button>
	{:else}
		<div class="danger-box" role="group" aria-label="Delete account">
			<p class="danger-title"><strong>Delete this account</strong></p>
			<p class="hint">
				This permanently deletes
				{#if account.email}<span class="font-mono">{account.email}</span>{:else}this
					identity{/if}. You'll be signed out everywhere and every connected app
				loses access immediately. This can't be undone.
			</p>

			{#if deleteStage === 'confirm' || deleteStage === 'requesting'}
				<label class="danger-field">
					<span>Type <span class="font-mono">delete</span> to continue</span>
					<input
						class="border px-2 py-1 text-sm font-mono"
						bind:value={deleteConfirmText}
						placeholder="delete"
						autocomplete="off"
						disabled={deleteStage === 'requesting'}
					/>
				</label>
				<div class="actions">
					<button
						type="button"
						class="danger"
						disabled={deleteStage === 'requesting'}
						onclick={startSudo}
					>
						{deleteStage === 'requesting' ? 'Sending…' : 'Continue'}
					</button>
					<button
						type="button"
						class="cancel"
						disabled={deleteStage === 'requesting'}
						onclick={cancelDelete}>Cancel</button
					>
				</div>
			{:else if deleteStage === 'awaiting-sudo'}
				<p class="hint">
					<strong>Check your email.</strong> We sent a confirmation link to
					{#if account.email}<span class="font-mono">{account.email}</span>{:else}this
						account{/if}. Open it on this device to confirm it's you, then come
					back here to finish.
				</p>
				{#if devLandingUrl}
					<p class="hint">
						<em>Dev seam:</em>
						<a href={devLandingUrl}>confirmation link</a>
					</p>
				{/if}
				<div class="actions">
					<button type="button" class="cancel" onclick={cancelDelete}>Cancel</button>
				</div>
			{:else if deleteStage === 'ready' || deleteStage === 'deleting'}
				<p class="hint">
					<strong>Identity confirmed.</strong> This is the point of no return.
				</p>
				<div class="actions">
					<button
						type="button"
						class="danger"
						disabled={deleteStage === 'deleting'}
						onclick={confirmDelete}
					>
						{deleteStage === 'deleting' ? 'Deleting…' : 'Permanently delete account'}
					</button>
					<button
						type="button"
						class="cancel"
						disabled={deleteStage === 'deleting'}
						onclick={cancelDelete}>Cancel</button
					>
				</div>
			{/if}

			{#if deleteError}
				<p class="danger-error" role="alert">{deleteError}</p>
			{/if}
		</div>
	{/if}
</section>

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

	.danger-zone {
		margin: 0.75rem 0 1rem;
	}
	.danger-toggle {
		background: transparent;
		border: none;
		color: #b91c1c;
		font-size: 0.85rem;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
	}
	.danger-box {
		border: 1px solid #fecaca;
		background: #fef2f2;
		color: #7f1d1d;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
	}
	.danger-box .danger-title {
		margin: 0 0 0.5rem;
	}
	.danger-box .hint {
		font-size: 0.85rem;
		color: #991b1b;
		margin: 0 0 0.5rem;
	}
	.danger-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		margin: 0.5rem 0;
	}
	.danger-box .actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.danger-box button {
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.danger-box button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.danger-box button.danger {
		background: #dc2626;
		border: none;
		color: white;
	}
	.danger-box button.cancel {
		background: transparent;
		border: 1px solid #d6d3d1;
		color: #57534e;
	}
	.danger-error {
		border: 1px solid #fecaca;
		background: white;
		color: #7f1d1d;
		padding: 0.4rem 0.6rem;
		border-radius: 0.35rem;
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
	}
</style>
