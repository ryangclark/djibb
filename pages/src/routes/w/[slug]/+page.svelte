<script>
	import { getContext } from 'svelte';
	import { WORKSPACE_REPLICACHE_KEY } from './_context.js';

	// ADR 0011 §7b.4: role display reads from the session projection
	// (membership.role) since the live entity row may briefly be empty
	// during pull. Lists in this workspace come in a follow-up.
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);
</script>

{#if ctx?.sessionWorkspace}
	<p class="text-sm text-stone-500">
		You are <strong>{ctx.sessionWorkspace.membership.role}</strong> in this workspace.
	</p>
	<p class="mt-4"><i>Lists in this workspace will appear here. (Phase 1: skeleton only.)</i></p>
{/if}
