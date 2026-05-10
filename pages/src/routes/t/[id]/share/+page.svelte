<script>
	// @ts-check
	/** Share-route stub for templates. See /l/[id]/share for notes. */
	import { page } from '$app/state';

	let templateId = $derived(page.params.id);
</script>

<svelte:head>
	<title>Share template — djibb</title>
</svelte:head>

<main>
	<h1>Share template</h1>
	<p>Template ID: <code>t/{templateId}</code></p>
	<p class="placeholder">
		The share UI hasn't been built yet. See ADR 0005 §"Open questions"
		for the design conversation that gates this route.
	</p>
	<p>
		<a href="/t/{templateId}">← Back to template</a>
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
