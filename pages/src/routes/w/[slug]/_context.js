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
 *   lastOutcome      — most-recent `mutation_outcome` WS frame
 *                       ({mutationID, status, reason?, message?}) or null.
 *                       Settings reads this to surface slug-claim
 *                       failures (slug_taken, slug_reserved, etc.) per
 *                       ADR 0011 §Step 7b.5; nulled out when consumed.
 *   pendingInvites   — live `pending_invites/*` rows from the workspace
 *                       DO (owner/admin-gated by the pull filter). The
 *                       members page feeds these to `EntityInvites` for
 *                       the invite/revoke surface per ADR 0011 §Step 10d.
 */
export const WORKSPACE_REPLICACHE_KEY = Symbol('workspaceReplicache');
