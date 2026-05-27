/**
 * Svelte context key for the workspace-page Replicache instance.
 * `/w/[slug]/+layout.svelte` setContext()s a getter-object keyed under
 * this symbol; children (members, settings, home) getContext() it to
 * subscribe to the workspace entity row + dispatch mutators.
 *
 * Shape (all getters — values are reactive):
 *   mutate           — wrapped mutator proxy (envelope-injected)
 *   workspace        — live entity row from Replicache (authoritative)
 *   workspaceId      — current entity id, e.g. "w/abc..."
 *   sessionWorkspace — {workspace, membership} projection from session
 *                       (slug, is_personal, projected role)
 */
export const WORKSPACE_REPLICACHE_KEY = Symbol('workspaceReplicache');
