<script>
	import { goto } from '$app/navigation';
	import { newId } from '@djibb/protocol/id';
	import { initList } from '$lib/replicache/index.svelte.js';
	import { setSessionState } from '$lib/session.svelte';
	import WorkspaceSwitcher from '$lib/components/WorkspaceSwitcher.svelte';
	import { onMount } from 'svelte';
	import '../app.css';

	let { children } = $props();

	/** Sticky pointers to ownerless Lists this browser minted anonymously
	 *  (written by the homepage's mint-on-engage). Read once at sign-in to
	 *  Adopt them in place. Must match the homepage's key. */
	const MINTED_KEY = 'djibb:minted_pending';

	// TODO: make this env variable?
	const footerSayings = ['you get to be who you want.'];
	let currentFooterSaying =
		footerSayings[Math.floor(footerSayings.length * Math.random())];

	const sessionState = setSessionState();

	onMount(() => {
		sessionState.fetchSession();

		// Keep the workspace switcher fresh while the tab stays open: an
		// invite/removal that lands elsewhere appears on the next focus.
		// No DO/CVR/poke — just revalidate the existing fetch (ADR 0013).
		function revalidateOnFocus() {
			if (document.visibilityState === 'visible') {
				sessionState.revalidateWorkspaces();
			}
		}
		document.addEventListener('visibilitychange', revalidateOnFocus);
		window.addEventListener('focus', revalidateOnFocus);
		return () => {
			document.removeEventListener('visibilitychange', revalidateOnFocus);
			window.removeEventListener('focus', revalidateOnFocus);
		};
	});

	// Adopt-on-sign-in: once a session resolves, claim every ownerless List
	// this browser minted while anonymous. Runs at most once per load
	// (`adopted` latch); the claim mutator is itself idempotent + CAS-
	// guarded, so a re-fire or a list someone else already claimed is a
	// harmless no-op server-side.
	let adopted = false;
	$effect(() => {
		if (adopted) return;
		if (!sessionState.hasLoaded || !sessionState.currentAccountId) return;
		adopted = true;
		adoptPendingMints(sessionState.currentAccountId, sessionState.currentWorkspaceId);
	});

	/**
	 * @param {string} accountId
	 * @param {string | null} workspaceId
	 */
	async function adoptPendingMints(accountId, workspaceId) {
		/** @type {string[]} */
		let pending;
		try {
			const raw = localStorage.getItem(MINTED_KEY);
			pending = raw ? JSON.parse(raw) : [];
		} catch {
			return; // localStorage unavailable (private mode) — nothing to adopt.
		}
		if (!Array.isArray(pending) || pending.length === 0) return;

		/** @type {ReturnType<typeof initList>[]} */
		const clients = [];
		for (const listId of pending) {
			if (typeof listId !== 'string') continue;
			try {
				// skipClientInit: the entity already exists server-side; never
				// optimistically re-create it. The claim mutation queues and
				// pushes; the server promotes ownerless → owner.
				const rc = initList({ accountId, listId, workspaceId, skipClientInit: true });
				clients.push(rc);
				await rc.mutate.claimEntity({ listId, workspaceId });
			} catch (err) {
				console.error('`adoptPendingMints()` claim failed for', listId, err);
			}
		}

		// Clear the pointers regardless of per-claim outcome: claims are
		// idempotent and an already-claimed list is terminal, so a failed or
		// raced pointer shouldn't be retried on every future load. Even if a
		// push hasn't flushed yet, the mutation persists in IndexedDB and the
		// same-named client resumes it when the user next opens the list.
		try {
			localStorage.removeItem(MINTED_KEY);
		} catch {
			// ignore — best-effort cleanup.
		}

		// Let Replicache flush the queued pushes, then release the transient
		// clients so they don't leak for the page's lifetime.
		setTimeout(() => {
			for (const rc of clients) rc.client.close();
		}, 3000);
	}

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
		<a href="/invitations">Invitations</a>
		<a href="/shared">Shared with me</a>
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
