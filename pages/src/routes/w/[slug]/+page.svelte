<script>
	import { getSessionState } from '$lib/session.svelte';
	import { page } from '$app/state';

	const session = getSessionState();
	const slug = $derived(page.params.slug);
	const current = $derived(
		session.workspaces.find(w => w.workspace.slug === slug)
	);
</script>

{#if current}
	<p class="text-sm text-stone-500">
		You are <strong>{current.membership.role}</strong> in this workspace.
	</p>
	<p class="mt-4"><i>Lists in this workspace will appear here. (Phase 1: skeleton only.)</i></p>
{/if}
