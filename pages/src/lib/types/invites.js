// @ts-check
/**
 * Shared pending-invitation shape (ADR 0009 `pending_invites/*`
 * keyspace). Lives in a plain module rather than inside a `.svelte`
 * component so consumers can import the type via
 * `import('$lib/types/invites.js').PendingInvite` — the
 * `import('…​.svelte').T` form doesn't resolve JSDoc typedefs under
 * svelte-check.
 *
 * @typedef {Object} PendingInvite
 * @property {'email'} identity_kind
 * @property {string} identity_value
 * @property {import('@djibb/protocol/auth/rules').AccountRole} role
 * @property {string} inviter_account_id
 * @property {number} time_created  unix seconds
 * @property {number} time_expires  unix seconds
 */

export {};
