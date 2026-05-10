<script>
	// @ts-check
	/**
	 * Share-route stub. Cmd+Shift+S from a list view lands here.
	 *
	 * The full share UI is out of scope until the share-flow design
	 * conversation lands — ADR 0005 §"Open questions" calls out the
	 * self-demotion forward-warning copy as a gating decision. Until
	 * then this page is a placeholder so the keymap binding resolves
	 * to a real route.
	 */
	import { page } from '$app/state';

	let listId = $derived(page.params.id);
</script>

<svelte:head>
	<title>Share list — djibb</title>
</svelte:head>

<main>
	<h1>Share list</h1>
	<p>List ID: <code>l/{listId}</code></p>
	<p class="placeholder">
		The share UI hasn't been built yet. See ADR 0005 §"Open questions"
		for the design conversation that gates this route.
	</p>
	<p>
		<a href="/l/{listId}">← Back to list</a>
	</p>
</main>

<style>
	main {
		max-width: 40rem;
		margin: 2rem auto;
		padding: 0 1rem;
	}
	.placeholder {
		opacity: 0.7;
		font-style: italic;
	}
</style>
