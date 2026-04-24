<!-- 
1. Get the session
2.a If session, show user's content 
2.b If not session, show sample list-from-template
-->

<script>
	import { getSessionState } from '$lib/session.svelte';

	const sessionState = getSessionState();
</script>

{#if sessionState.accounts.length}
	<!-- TEMP: Show current account info. -->
     <h2 class="text-xl">Account Info</h2>
     <p>Display Name: {sessionState.accounts[0].display_name}</p>
     <p>ID: {sessionState.accounts[0].id}</p>
	
     <!-- TODO: Show the user-relevant content, hopefully we can save last used thing and load that? -->
{:else}
	<h1>djibb</h1>
	<p class="ml-8">Building beautiful, remixable checklists.</p>
{/if}
