<script>
	import { page } from '$app/state';
	import { getSessionState } from '$lib/session.svelte';

	const session = getSessionState();
	let { children } = $props();

	const slug = $derived(page.params.slug);

	$effect(() => {
		if (slug && session.workspaces.length && session.currentWorkspaceSlug !== slug) {
			session.setActiveWorkspace(slug);
		}
	});

	const current = $derived(
		session.workspaces.find(w => w.workspace.slug === slug)
	);
</script>

<div class="m-8">
	{#if current}
		<header class="mb-6">
			<h1 class="text-2xl">
				{current.workspace.name ?? (current.workspace.is_personal ? 'Your space' : current.workspace.slug)}
			</h1>
			<nav class="flex gap-4 text-sm mt-1">
				<a href={`/w/${slug}`}>Home</a>
				<a href={`/w/${slug}/members`}>Members</a>
				<a href={`/w/${slug}/settings`}>Settings</a>
			</nav>
		</header>
		{@render children()}
	{:else}
		<p>Workspace not found in your session, or still loading…</p>
	{/if}
</div>
