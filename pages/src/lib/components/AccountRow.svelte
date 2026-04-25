<script>
	import { OAUTH_PROVIDER_PRETTY } from '$djibb/auth/constants';
	import { getSessionState, STATUSES } from '$lib/session.svelte';

	/**
	 * @type {{account: import("$djibb/account/index").Account}}
	 */
	const { account } = $props();

	const sessionState = getSessionState();
	let signingOut = $state(false);

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
	</div>

	<button
		class="p-2 border border-stone-900 disabled:opacity-50"
		disabled={signingOut}
		onclick={handleSignOut}
	>
		{signingOut ? 'Signing out...' : 'Sign out'}
	</button>
</div>
