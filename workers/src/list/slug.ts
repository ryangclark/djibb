/**
 * Slug claim arbitration for the `workspace_entities` catalog (ADR 0011
 * §Step 7b.5). The single-DO server mutator can't see other DOs' slugs;
 * D1 holds the `UNIQUE(type, slug)` invariant. This module provides:
 *
 *   - `SLUG_PATTERN` / `RESERVED_SLUGS` — local validation, fast-fail
 *     before any D1 round-trip.
 *   - `tryClaimSlug` — atomic guarded UPDATE that either swaps the slug
 *     on a row (returning `{ ok: true }`) or returns a structured
 *     conflict reason. Called by the in-DO preflight for
 *     `setWorkspaceSlug` (and any future setSlug mutator for other
 *     entity types).
 *
 * The claim is atomic by relying on the UNIQUE index: the UPDATE
 * either applies (`meta.changes === 1`) or trips the constraint
 * (caught and reported as `slug_taken`). No SELECT-then-UPDATE race
 * to think about — SQLite's per-statement atomicity handles it.
 */

/**
 * Mirrors the legacy `workers/src/workspace/index.ts::SLUG_PATTERN`.
 * 3-40 chars, lowercase alphanumeric + hyphen, no leading/trailing
 * hyphen.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

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

/**
 * Atomically attempt to set `slug` on a `workspace_entities` row.
 *
 * Validates the slug locally (pattern + reserved set), then runs a
 * single guarded UPDATE. The UPDATE's `WHERE NOT EXISTS (collision)`
 * predicate makes the check-and-write atomic at the statement level;
 * a concurrent claim of the same slug either lands first (our UPDATE
 * sees the collision and rowsWritten = 0) or lands second (the UNIQUE
 * index trips on insert side). The UNIQUE constraint catch covers
 * the race where the collision check passes but the index fires
 * between predicate eval and write — vanishingly rare in SQLite's
 * per-statement world, but cheap to be paranoid.
 *
 * Entity-typed: the collision check is scoped to `type = ?` so
 * `/w/myteam` and `/l/myteam` can coexist (UNIQUE(type, slug) on
 * the catalog).
 */
export async function tryClaimSlug(
    d1: D1Database,
    entityId: string,
    entityType: 'list' | 'template' | 'workspace',
    newSlug: string,
): Promise<SlugClaimResult> {
    if (!SLUG_PATTERN.test(newSlug)) {
        return {
            ok: false,
            reason: 'slug_invalid',
            message: `Slug "${newSlug}" doesn't match the allowed pattern (3-40 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen).`,
        };
    }
    if (RESERVED_SLUGS.has(newSlug)) {
        return {
            ok: false,
            reason: 'slug_reserved',
            message: `Slug "${newSlug}" is reserved.`,
        };
    }

    try {
        const result = await d1
            .prepare(
                `UPDATE workspace_entities
                    SET slug = ?
                  WHERE id = ?
                    AND type = ?
                    AND time_deleted IS NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM workspace_entities
                         WHERE type = ?
                           AND slug = ?
                           AND id != ?
                    )`,
            )
            .bind(newSlug, entityId, entityType, entityType, newSlug, entityId)
            .run();
        const rowsWritten =
            (result.meta as { changes?: number } | undefined)?.changes ?? 0;
        if (rowsWritten === 0) {
            // Either the row doesn't exist (or is soft-deleted), or
            // the collision check tripped. Disambiguate with a cheap
            // followup lookup so the outcome reason is honest.
            const existing = await d1
                .prepare(
                    `SELECT 1 FROM workspace_entities
                      WHERE id = ?
                        AND type = ?
                        AND time_deleted IS NULL
                      LIMIT 1`,
                )
                .bind(entityId, entityType)
                .first();
            if (!existing) {
                return {
                    ok: false,
                    reason: 'entity_missing',
                    message: `No ${entityType} found for id "${entityId}".`,
                };
            }
            return {
                ok: false,
                reason: 'slug_taken',
                message: `Slug "${newSlug}" is already in use by another ${entityType}.`,
            };
        }
        return { ok: true };
    } catch (error) {
        // UNIQUE constraint violation — same outcome as the
        // NOT EXISTS predicate catching the collision, just delivered
        // by the index instead of the subquery.
        const msg = error instanceof Error ? error.message : String(error);
        if (/UNIQUE|constraint/i.test(msg)) {
            return {
                ok: false,
                reason: 'slug_taken',
                message: `Slug "${newSlug}" is already in use by another ${entityType}.`,
            };
        }
        throw error;
    }
}
