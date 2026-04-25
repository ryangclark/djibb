<!-- TODO: make this page CSR-only? -->
<script>
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { getSessionState, STATUSES } from '$lib/session.svelte';

	import AccountRow from '$lib/components/AccountRow.svelte';

	const { data } = $props();

	const { accountId } = data;

	if (!accountId) {
		goto('/accounts');
		throw new Error();
	}

	const sessionState = getSessionState();

	onMount(() => {
		if (typeof window === 'undefined' || !window.opener) return;

		try {
			window.opener.postMessage(
				{ type: 'djibb:oauth-success', accountId },
				window.location.origin
			);
		} catch (err) {
			console.error('postMessage to opener failed:', err);
			return;
		}

		window.close();
	});

	/**
	 * @type {import("$djibb/account/index").Account | undefined}
	 */
	const account = $derived.by(() => {
		for (const account of sessionState.accounts) {
			if (account.id === accountId) {
				return account;
			}
		}
	});

	let closeWindowAttempted = false;
</script>

{#if sessionState.status === STATUSES.loading}
	<h2 class="text-xl">Loading...</h2>
	<p>One moment, please</p>
{:else if account}
	<h2 class="text-xl mb-2">Account added!</h2>
	<p class="mb-2">Your account is now authorized:</p>

	<AccountRow {account}></AccountRow>

	<!-- Add other post-auth buttons/links here, as appropriate. -->
	<!-- AH! Make a button that says "add another account" or 
	  something to expose the user to the concept of multiple accounts,
	  even if they don't use them (now/yet/etc.). -->
	<button
		class="p-2 m-2 border-stone-900 border"
		onclick={() => {
			goto('/accounts');
		}}>Add another</button
	>
{:else}
	<h2 class="text-xl">An error occurred...</h2>
	<p>That's all we know. Please try again if you are able.</p>
	<p>Thank you for your patience.</p>
{/if}

<!-- Allow user to close the window because this route is most likely
 rendered within a popup-sized window. Get the user back to the 
 full-size window they came from! (Might not be needed in mobile?) -->
<button
	class="m-2 p-2 border-stone-900 border"
	disabled={closeWindowAttempted}
	onclick={() => {
		window?.close();
	}}>Close window</button
>
