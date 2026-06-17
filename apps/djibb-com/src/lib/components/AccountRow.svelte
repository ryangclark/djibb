<script>
	import { OAUTH_PROVIDER_PRETTY } from '@djibb/protocol/auth/constants';
	import { getSessionState, STATUSES } from '$lib/session.svelte';
	import { setAccountUsername } from '$lib/api/account';

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

	async function handleSignOut() {
		if (signingOut) return;
		signingOut = true;

		try {
			const response = await fetch(
				`${import.meta.env.VITE_API_BASE_URL}/auth/session/accounts`,
				{
					method: 'DELETE',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ account_id: account.id })
				}
			);

			if (!response.ok) {
				console.error('Sign-out failed:', response.status);
				signingOut = false;
				return;
			}

			if (sessionState.status === STATUSES.idle) {
				await sessionState.fetchSession();
			}
		} catch (err) {
			console.error('Sign-out error:', err);
		}

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
