import { z } from 'zod';

import {
    type AuthorizationRules,
    AuthorizationRulesSchema,
} from '@djibb/protocol/auth/rules';
import { UnexpectedError } from '@djibb/protocol/errors';
import { ENTITY_ROW_TYPES, SlotEnum, type Slot } from '@djibb/protocol/list';
import {
    defaultSlugForId,
    RESERVED_SLUGS,
    SLUG_PATTERN,
    type SlugClaimResult,
} from '@djibb/protocol/list/slug';

// Re-export the pure default-slug derivation (now owned by
// `@djibb/protocol/list/slug`) so existing `../entity` importers — the
// snapshot projector below and a couple of test fixtures — keep resolving.
export { defaultSlugForId };

/**
 * Snapshot of entity metadata as it lives in the D1 `workspace_entities`
 * read index. Per ADR 0003 the DO is authoritative; this row is a
 * derived projection emitted by the DO post-commit. The worker reads it
 * for the auth fast path and catalog queries.
 */
export const EntityRowSchema = z.object({
    id: z.string(),
    workspace_id: z.string().nullable(),
    type: z.enum(ENTITY_ROW_TYPES),
    name: z.string().nullable(),
    description: z.string().nullable(),
    forked_from_id: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()).nullable(),
    /**
     * Per-type-namespaced routing alias (ADR 0011 §Step 7b.5). Always
     * present in the D1 catalog (`NOT NULL` on the column, defaulted
     * to the id suffix at emit time for entities that haven't set
     * one). UNIQUE(type, slug) lets `/w/myteam` and `/l/myteam` live
     * side-by-side.
     */
    slug: z.string(),
    slot: SlotEnum.nullable(),
    /**
     * The workspace whose `softDeleteWorkspace` cascade-archived this
     * entity (ADR 0008, ADR 0011 §Step 10a). NULL on every entity that
     * hasn't been cascade-archived — which is every entity at rest. Set
     * by cascade-archive mutations; cleared by `restoreWorkspace` via
     * direct catalog UPDATE.
     */
    cascade_source: z.string().nullable(),
    authorization_rules: AuthorizationRulesSchema,
    time_created: z.number(),
    time_updated: z.number(),
    time_deleted: z.number().nullable(),
    version: z.number(),
});

export type EntityRow = z.infer<typeof EntityRowSchema>;

function parseRow(row: any): EntityRow {
    const rules =
        typeof row.authorization_rules === 'string'
            ? JSON.parse(row.authorization_rules)
            : row.authorization_rules;
    const meta =
        row.meta && typeof row.meta === 'string'
            ? JSON.parse(row.meta)
            : row.meta ?? null;
    const parsed = EntityRowSchema.safeParse({
        id: row.id,
        workspace_id: row.workspace_id ?? null,
        type: row.type,
        name: row.name ?? null,
        description: row.description ?? null,
        forked_from_id: row.forked_from_id ?? null,
        meta,
        slug: row.slug,
        slot: row.slot ?? null,
        cascade_source: row.cascade_source ?? null,
        authorization_rules: rules,
        time_created: row.time_created,
        time_updated: row.time_updated,
        time_deleted: row.time_deleted ?? null,
        version: row.version,
    });
    if (!parsed.success) {
        console.error('parseEntityRow error:', parsed.error.format());
        throw new UnexpectedError();
    }
    return parsed.data;
}

/**
 * Read just the `version` column for an entity. Used by the alarm-
 * driven reconciliation sweeper (ADR 0007) to decide whether the
 * full snapshot upsert is necessary — when D1's version already
 * matches the DO's, the upsert is skipped and the alarm re-arms.
 *
 * Returns null when the row doesn't exist (D1 missing the entity
 * entirely — drift the alarm needs to repair via an unconditional
 * emit).
 */
export async function GetEntityVersion(
    d1: D1Database,
    id: string,
): Promise<number | null> {
    const row = await d1
        .prepare(`SELECT version FROM workspace_entities WHERE id = ? LIMIT 1`)
        .bind(id)
        .first<{ version: number }>();
    return row?.version ?? null;
}

export async function GetEntity(
    d1: D1Database,
    id: string,
): Promise<EntityRow | null> {
    const row = await d1
        .prepare(
            `SELECT id, workspace_id, type, name, description, forked_from_id,
                    meta, slug, slot, cascade_source, authorization_rules,
                    time_created, time_updated, time_deleted, version
             FROM workspace_entities WHERE id = ? LIMIT 1`,
        )
        .bind(id)
        .first();
    if (!row) return null;
    return parseRow(row);
}

export type EntitySnapshot = {
    id: string;
    workspace_id: string | null;
    type: 'list' | 'template' | 'workspace';
    name: string;
    description: string | null;
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    /**
     * Optional on the DO-side snapshot (ADR 0011 §Step 7b.5). When
     * absent, the projection writer defaults to the id suffix — the
     * nanoid that already lives after the type prefix — so the D1 NOT
     * NULL constraint is satisfied for every entity, even those whose
     * mutators don't carry a slug field yet (lists, templates).
     */
    slug?: string;
    slot: Slot | null;
    /**
     * Optional on the DO-side snapshot (ADR 0011 §Step 10a / ADR 0008).
     * The DO entity row carries `cascade_source` natively (10a.4a)
     * alongside `time_deleted`; `emitEntitySnapshot` reads it from the
     * row and threads it here. NULL means "live, or user-archived" —
     * indistinguishable at this layer; the projection writer's ON
     * CONFLICT UPDATE COALESCEs into the existing value so a
     * non-cascade emit (e.g. a rename arriving after the cascade has
     * already stamped this row) can't clobber the breadcrumb. Clearing
     * happens when `unarchiveEntity` runs against the row — the next
     * emit then carries NULL forward via the same COALESCE, except
     * cascade-restore (10a.5) issues a direct catalog UPDATE to clear
     * the projection promptly without waiting on a subsequent emit.
     */
    cascade_source?: string | null;
    authorization_rules: AuthorizationRules;
    time_created: number;
    time_updated: number;
    time_deleted: number | null;
    version: number;
};


/**
 * Emit a current-state snapshot of an entity to the D1 read index. Per
 * ADR 0003 the DO is authoritative; this is a denormalized projection.
 *
 * Shaped as a current-state UPSERT rather than a diff event because the
 * single subscriber (the catalog) only needs latest state. When the
 * event bus arrives (see ADR 0003 §"Future evolution"), this becomes
 * one subscriber on a fan-out and the payload promotes to a domain
 * event with type-tag and prior values.
 *
 * Idempotent. Safe to retry. Failures are logged by the caller and
 * recovered by the next emit (or the reconciliation sweeper per
 * ADR 0007).
 *
 * Version-guarded: the DO UPDATE only fires when `excluded.version`
 * (the version being emitted) is at least as high as the version
 * currently in D1. Prevents a stale emit — for instance, an alarm-
 * driven reconciliation that read DO version N concurrently with a
 * fresh mutation landing N+1 — from downgrading the read index.
 */
/**
 * Membership row as it lives in the D1 `entity_memberships` projection
 * (ADR 0011 §Step 7). Derived from `authorization_rules.authorized_accounts`
 * on the entity row; emitted post-commit from the DO alongside
 * `EmitEntitySnapshotToCatalog`.
 */
export type MembershipRow = {
    account_id: string;
    entity_id: string;
    role: string;
};

/**
 * Emit a current-state snapshot of an entity's memberships to D1.
 * Delete-then-insert by entity_id. Single batch so a partial failure
 * doesn't leave stale rows.
 *
 * Same idempotent / fire-and-pray posture as
 * `EmitEntitySnapshotToCatalog`. Failures are recovered by the next
 * emit or by the reconciliation sweeper (ADR 0007), which is extended
 * in step 7 to rebuild the projection from the rules JSON.
 *
 * Not version-guarded. The DO is single-writer for the rules JSON, and
 * the rules are the source of truth; a stale concurrent emit can only
 * overwrite with the value already in D1. (If we get to a world where
 * two emits race with different rules versions, the same `version >=`
 * guard the entity row uses will need to land here too — likely backed
 * by storing `time_updated` per row and comparing.)
 */
export async function EmitEntityMembershipsToCatalog(
    d1: D1Database,
    args: {
        entityId: string;
        authorizedAccounts: Record<string, { role: string }>;
        timeUpdated: number;
    },
): Promise<void> {
    const statements: D1PreparedStatement[] = [
        d1
            .prepare(`DELETE FROM entity_memberships WHERE entity_id = ?`)
            .bind(args.entityId),
    ];
    for (const [accountId, { role }] of Object.entries(
        args.authorizedAccounts
    )) {
        statements.push(
            d1
                .prepare(
                    `INSERT INTO entity_memberships
                        (account_id, entity_id, role, time_updated)
                     VALUES (?, ?, ?, ?)`
                )
                .bind(accountId, args.entityId, role, args.timeUpdated)
        );
    }
    await d1.batch(statements);
}

/**
 * Read the role an account holds on an entity, from the D1 membership
 * projection. Returns null when no membership row exists. Used by the
 * auth resolver fast path (ADR 0011 §Step 8) — D1 is a projection so a
 * read here may briefly lag the DO; the DO mutator gates re-check the
 * authoritative rules in the same commit, so a missed membership at the
 * boundary can at worst skip a permitted action, never grant a denied
 * one.
 */
export async function GetEntityMembershipRole(
    d1: D1Database,
    accountId: string,
    entityId: string,
): Promise<string | null> {
    const row = await GetMembershipRow(d1, accountId, entityId);
    return row?.role ?? null;
}

const MembershipIndexRowSchema = z.object({
    account_id: z.string(),
    role: z.string(),
    time_joined: z.number(),
});

export type MembershipIndexRow = z.infer<typeof MembershipIndexRowSchema>;

/**
 * Read an account's membership row on an entity from the
 * `entity_memberships` projection. `time_joined` is the projection's
 * `time_updated` (epoch seconds) — the emit that last rewrote the row.
 * Returns null when no membership exists. Role-enum narrowing is the
 * caller's concern; the projection stores whatever the rules JSON held.
 */
export async function GetMembershipRow(
    d1: D1Database,
    accountId: string,
    entityId: string,
): Promise<MembershipIndexRow | null> {
    const row = await d1
        .prepare(
            `SELECT account_id, role, time_updated AS time_joined
             FROM entity_memberships
             WHERE account_id = ? AND entity_id = ? LIMIT 1`,
        )
        .bind(accountId, entityId)
        .first();
    if (!row) return null;
    const parsed = MembershipIndexRowSchema.safeParse(row);
    if (!parsed.success) {
        console.error('GetMembershipRow parse error:', parsed.error.format());
        throw new UnexpectedError();
    }
    return parsed.data;
}

const WorkspaceForAccountRowSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    slug: z.string(),
    slot: SlotEnum.nullable(),
    /** Raw JSON blob as stored; view-shaping (image_url etc.) is the caller's. */
    meta: z.string().nullable(),
    time_created: z.number(),
    time_deleted: z.number().nullable(),
    time_updated: z.number(),
    role: z.string(),
    time_joined: z.number(),
});

export type WorkspaceForAccountRow = z.infer<typeof WorkspaceForAccountRowSchema>;

/**
 * Every live workspace an account is a member of, from the
 * `entity_memberships` ⋈ `workspace_entities` projections — personal
 * workspace first, then by creation time (ADR 0011 §Step 7b.2).
 */
export async function GetWorkspaceRowsForAccount(
    d1: D1Database,
    accountId: string,
): Promise<WorkspaceForAccountRow[]> {
    const result = await d1
        .prepare(
            `SELECT
                we.id, we.name, we.slug, we.slot, we.meta,
                we.time_created, we.time_deleted, we.time_updated,
                em.role, em.time_updated AS time_joined
            FROM entity_memberships em
            JOIN workspace_entities we ON we.id = em.entity_id
            WHERE em.account_id = ?
              AND we.type = 'workspace'
              AND we.time_deleted IS NULL
            ORDER BY (we.slot = 'personal_workspace') DESC, we.time_created ASC`,
        )
        .bind(accountId)
        .all();
    if (!result.success) {
        console.error('GetWorkspaceRowsForAccount query failed');
        throw new UnexpectedError();
    }
    return result.results.map((row) => {
        const parsed = WorkspaceForAccountRowSchema.safeParse(row);
        if (!parsed.success) {
            console.error(
                'GetWorkspaceRowsForAccount parse error:',
                parsed.error.format(),
            );
            throw new UnexpectedError();
        }
        return parsed.data;
    });
}

/**
 * ADR 0011 §Step 10d.3: resolve a workspace slug to its entity id +
 * name, but ONLY for a caller who actually holds a pending invitation
 * to that workspace.
 *
 * The pre-membership accept surface (`/w/[slug]` invitee branch) needs
 * the entity id to mount Replicache by id — but the account isn't a
 * member yet, so it can't come off the session's workspace list. A bare
 * slug→id lookup would be a discovery oracle: workspace slugs are
 * human-guessable (unlike entity nanoids), and restricted-role pulls are
 * currently permitted (see the ADR 0009 shakedown handoff, corner #6),
 * so leaking the id would let any authed user read a workspace's
 * contents. Gating on a pending invite in `entity_invitations_index`
 * keeps this purpose-specific: you can only resolve a workspace you were
 * invited to.
 *
 * `identityValues` is the set of verified email identities for the
 * active account (lowercased), matched against pending, unexpired
 * invite rows. Returns null when no slug match, no pending invite, or
 * the invite expired — the route maps all of these to 404 so the
 * negative cases are indistinguishable.
 */
export async function ResolveInvitedWorkspaceBySlug(
    d1: D1Database,
    {
        slug,
        identityValues,
        nowSeconds,
    }: { slug: string; identityValues: string[]; nowSeconds: number },
): Promise<{ id: string; name: string | null } | null> {
    if (identityValues.length === 0) return null;
    const placeholders = identityValues.map(() => '?').join(', ');
    const row = await d1
        .prepare(
            `SELECT we.id AS id, we.name AS name
            FROM workspace_entities we
            JOIN entity_invitations_index ei ON ei.target_id = we.id
            WHERE we.type = 'workspace'
              AND we.slug = ?
              AND we.time_deleted IS NULL
              AND ei.target_type = 'workspace'
              AND ei.status = 'pending'
              AND ei.identity_kind = 'email'
              AND ei.time_expires > ?
              AND ei.identity_value IN (${placeholders})
            LIMIT 1`,
        )
        .bind(slug, nowSeconds, ...identityValues)
        .first<{ id: string; name: string | null }>();
    if (!row) return null;
    return { id: row.id, name: row.name ?? null };
}

export async function EmitEntitySnapshotToCatalog(
    d1: D1Database,
    snapshot: EntitySnapshot,
): Promise<void> {
    // ADR 0011 §Step 7b.5: slug is auto-defaulted to the id suffix
    // when the DO didn't carry one. The slug column itself is NOT
    // NULL; the UNIQUE(type, slug) index does the cross-DO arbitration
    // for any future write that re-emits a different slug for the same
    // entity (the only path that re-emits is `setWorkspaceSlug`, which
    // runs an in-DO preflight against this same catalog before writing
    // — so a UNIQUE conflict here would be an invariant violation, not
    // a normal race). The ON CONFLICT UPDATE does NOT update slug —
    // slug changes go through the preflighted mutator, not snapshot
    // emit. This keeps a stale emit (e.g. alarm-driven reconciliation)
    // from clobbering a freshly-claimed slug.
    const slug = snapshot.slug ?? defaultSlugForId(snapshot.id);
    // ADR 0011 §Step 10a / ADR 0008: cascade_source rides through here
    // because the DO entity row carries it natively (10a.4a) — every
    // emit just mirrors the row's value. Set by `cascadeArchiveList`,
    // cleared by `unarchiveEntity`. The ON CONFLICT UPDATE writes the
    // value unconditionally (no COALESCE) because the row is
    // authoritative: a non-cascade emit on an already-archived row
    // still carries the cascade_source forward from the row, and an
    // unarchive emit must clear the projection's value. Cascade-
    // restore (10a.5) additionally issues a direct catalog UPDATE to
    // clear the projection promptly for any rows whose own DO emit
    // hasn't landed yet.
    const cascadeSource = snapshot.cascade_source ?? null;
    await d1
        .prepare(
            `INSERT INTO workspace_entities (
                id, workspace_id, type, name, description, forked_from_id,
                meta, slug, slot, cascade_source, authorization_rules,
                time_created, time_updated, time_deleted, version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                name = excluded.name,
                description = excluded.description,
                forked_from_id = excluded.forked_from_id,
                meta = excluded.meta,
                slot = excluded.slot,
                cascade_source = excluded.cascade_source,
                authorization_rules = excluded.authorization_rules,
                time_updated = excluded.time_updated,
                time_deleted = excluded.time_deleted,
                version = excluded.version
             WHERE excluded.version >= workspace_entities.version`,
        )
        .bind(
            snapshot.id,
            snapshot.workspace_id,
            snapshot.type,
            snapshot.name,
            snapshot.description,
            snapshot.forked_from_id,
            snapshot.meta ? JSON.stringify(snapshot.meta) : null,
            slug,
            snapshot.slot,
            cascadeSource,
            JSON.stringify(snapshot.authorization_rules),
            snapshot.time_created,
            snapshot.time_updated,
            snapshot.time_deleted,
            snapshot.version,
        )
        .run();
}

/**
 * Atomically attempt to set `slug` on a `workspace_entities` row —
 * slug claim arbitration for the catalog (ADR 0011 §Step 7b.5, backend
 * half). The single-DO server mutator can't see other DOs' slugs; D1
 * holds the `UNIQUE(type, slug)` invariant. The pure validation
 * contract (`SLUG_PATTERN`, `RESERVED_SLUGS`, the `SlugClaim*` result
 * shape) lives in `@djibb/protocol/list/slug`. Called by the in-DO
 * preflight for `setWorkspaceSlug` (and any future setSlug mutator for
 * other entity types).
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
