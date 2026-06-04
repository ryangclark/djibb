<script>
	import { getContext } from 'svelte';
	import { WORKSPACE_REPLICACHE_KEY } from './_context.js';

	// ADR 0011 §7b.4: role display reads from the session projection
	// (membership.role) since the live entity row may briefly be empty
	// during pull.
	//
	// What goes here long-term: the workspace's Island view (hex map
	// of the workspace's Lists), per ADR 0002. The Island is a real
	// multi-slice effort — algorithmic placement, persisted hex
	// coords, two-axis state encoding, Dock affordance, pan/zoom
	// surface — tracked independently from ADR 0011. Until that lands,
	// this page intentionally surfaces just the role indicator so the
	// surrounding chrome (header, switcher, settings/members nav) is
	// usable without implying a list-of-lists picker is coming. A
	// list-of-lists is explicitly rejected by ADR 0002 as the primary
	// view for an authed workspace.
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);
</script>

{#if ctx?.sessionWorkspace}
	<p class="text-sm text-stone-500">
		You are <strong>{ctx.sessionWorkspace.membership.role}</strong> in this workspace.
	</p>
	<p class="mt-4 text-stone-500">
		<i>The workspace Island view (ADR 0002) lands here in a future slice.</i>
	</p>
{/if}
