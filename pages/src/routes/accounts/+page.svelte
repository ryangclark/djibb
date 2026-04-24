<script>
	import { getSessionState } from '$lib/session.svelte';

	import AccountRow from '$lib/components/AccountRow.svelte';
	import GoogleOAuth from './google.svelte';

	const sessionState = getSessionState();
</script>

<h1 class="text-2xl mb-2">Accounts</h1>
<p>
	djibb does not care if you use no account, or 100 account. Is your choice
	entirety.
</p>
<p>
	Some like to save list to account so they are finding it later safely, and
	some have no need for such thing.
</p>

<section class="my-8">
	<h2 class="text-xl mb-2">Sign in</h2>

	<p>Needing another account? Sign into it here</p>

	<div class="my-8"><GoogleOAuth></GoogleOAuth></div>
</section>

<!-- IDEA: it might be neat to have a section of the user's 
 lists if the user isn't authenticated and, thus, those are
 Unsaved Lists we should show the user to remind them what's at stake... -->

<section>
	<h2 class="text-xl mb-2">Signed-in accounts</h2>
	{#if sessionState.accounts.length}
		<p class="mb-6">This accounts is already signed in:</p>
	{/if}

	{#each sessionState.accounts as account}
		<AccountRow {account}></AccountRow>
	{:else}
		<p class="italic">No accounts signed in yet</p>
	{/each}
</section>
