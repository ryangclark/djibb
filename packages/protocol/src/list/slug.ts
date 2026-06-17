/**
 * Slug validation contract for the `workspace_entities` catalog (ADR 0011
 * §Step 7b.5) — the pure half: the format pattern, the reserved set, and
 * the structured claim-result shape. Both client and server validate
 * against these; the actual atomic D1 claim (`tryClaimSlug`) lives in the
 * Cloudflare backend (`workers/src/list/slug.ts`), since it needs a
 * `D1Database` and SQLite's per-statement atomicity.
 */

/**
 * Mirrors the legacy `workers/src/workspace/index.ts::SLUG_PATTERN`.
 * 3-40 chars, lowercase alphanumeric + hyphen, no leading/trailing
 * hyphen.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * The default slug an entity gets at mint: the id's suffix after the
 * first `/` (the namespace separator), or the whole id when there is
 * none. Pure string derivation — used both when minting an entity and
 * when projecting a snapshot to the catalog read index.
 */
export function defaultSlugForId(id: string): string {
    const i = id.indexOf('/');
    return i === -1 ? id : id.slice(i + 1);
}

/**
 * Slugs that would clash with worker route prefixes or front-end
 * routes, or have admin-y connotations. Reserved across every entity
 * type — a list can't be `admin` either, regardless that the URL would
 * be `/l/admin` not `/admin`. Cheap insurance against future routing
 * changes (and ADR 0002's island-homepage flat-`/<slug>` direction,
 * where these collisions become live rather than hypothetical).
 *
 * `account/username.ts::RESERVED_USERNAMES` spreads this set so the two
 * namespaces can't drift; keep username-only additions there.
 *
 * Auto-defaulted suffixes (the nanoid after the type prefix) bypass
 * this check: a `newId('workspace')` is alphanumeric uniform-random
 * across the full alphabet and won't equal a reserved word in
 * practice. Validation runs only on user-supplied slugs entering via
 * `setWorkspaceSlug`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
    // Admin-y / auth route words.
    'admin',
    'api',
    'app',
    'auth',
    'help',
    'login',
    'logout',
    'new',
    'settings',
    'signup',
    'support',
    // Live top-level front-end routes (pages/src/routes/*).
    'accounts',
    'invitations',
    'shared',
    'trash',
    'workspaces',
    // Entity-prefix + nested route segments (defensive — see ADR 0002).
    'l',
    't',
    'w',
    'a',
    'workspace',
    'members',
    'invites',
]);

export type SlugClaimFailureReason =
    | 'slug_invalid'
    | 'slug_reserved'
    | 'slug_taken'
    | 'entity_missing';

export type SlugClaimResult =
    | { ok: true }
    | { ok: false; reason: SlugClaimFailureReason; message: string };
