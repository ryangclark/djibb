<script>
	import { goto } from '$app/navigation';
	import { newId } from '$djibb/id';
	import { setSessionState } from '$lib/session.svelte';
	import WorkspaceSwitcher from '$lib/components/WorkspaceSwitcher.svelte';
	import { onMount } from 'svelte';
	import '../app.css';

	let { children } = $props();

	// TODO: make this env variable?
	const footerSayings = ['you get to be who you want.'];
	let currentFooterSaying =
		footerSayings[Math.floor(footerSayings.length * Math.random())];

	const sessionState = setSessionState();

	onMount(() => {
		sessionState.fetchSession();
	});

	function newList() {
		// Visiting /l/<fresh-id> is the create-list flow: the list page
		// detects an empty Replicache store and fires `initList`.
		goto(`/${newId('list')}`);
	}

	function newTemplate() {
		// Same flow as newList, but the `t/` prefix routes through the
		// template app and the init mutator stamps `type: 'template'`.
		goto(`/${newId('template')}`);
	}
</script>

<header class="m-8 flex gap-10 items-center">
	<a class="mr-10" href="/">djibb</a>
	<nav class="flex gap-8">
		<a href="/">Home</a>
		<a href="/posts">Blog</a>
		<a href="/accounts">Accounts</a>
		<button onclick={newList}>+ New list</button>
		<button onclick={newTemplate}>+ New template</button>
	</nav>
	<div class="ml-auto">
		<WorkspaceSwitcher />
	</div>
</header>

<main>
	{@render children()}
</main>

<!--
TODO: I dunno, let's do something fun for the footer sayings.
Something like the saying only shows/loads when you hover your cursor over it,
or only on the second view of the footer (would need to be tall-enough page...)
-->
<footer class="flex justify-end">
	<p class="text-stone-500 text-sm m-4">{currentFooterSaying}</p>
</footer>

<style>
	footer {
		grid-area: footer;
	}

	header {
		grid-area: nav;
	}

	main {
		grid-area: main;
	}
</style>
