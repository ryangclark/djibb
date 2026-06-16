/**
 * Slug claim arbitration for the `workspace_entities` catalog (ADR 0011
 * §Step 7b.5) — the backend half. The single-DO server mutator can't see
 * other DOs' slugs; D1 holds the `UNIQUE(type, slug)` invariant.
 *
 * The pure validation contract (`SLUG_PATTERN`, `RESERVED_SLUGS`, the
 * `SlugClaim*` result shape) now lives in `@djibb/protocol/list/slug`;
 * this module owns only `tryClaimSlug` — the atomic guarded UPDATE that
 * either swaps the slug on a row (`{ ok: true }`) or returns a structured
 * conflict reason. Called by the in-DO preflight for `setWorkspaceSlug`
 * (and any future setSlug mutator for other entity types).
 *
 * The claim is atomic by relying on the UNIQUE index: the UPDATE
 * either applies (`meta.changes === 1`) or trips the constraint
 * (caught and reported as `slug_taken`). No SELECT-then-UPDATE race
 * to think about — SQLite's per-statement atomicity handles it.
 */

import {
    SLUG_PATTERN,
    RESERVED_SLUGS,
    type SlugClaimResult,
} from '@djibb/protocol/list/slug';

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
