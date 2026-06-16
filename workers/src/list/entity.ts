import { z } from 'zod';

import {
    type AuthorizationRules,
    AuthorizationRulesSchema,
} from '@djibb/protocol/auth/rules';
import { UnexpectedError } from '@djibb/protocol/errors';
import { ENTITY_ROW_TYPES, SlotEnum, type Slot } from '@djibb/protocol/list';

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
 * Default slug for an entity that didn't carry one on its DO row.
 * The id is shaped `<type>/<suffix>` (e.g. `w/abc123`) and the suffix
 * — a fresh nanoid — already satisfies SLUG_PATTERN by construction.
 * Used by `EmitEntitySnapshotToCatalog` as the auto-default and by
 * any test fixture that needs to mirror that behavior.
 */
export function defaultSlugForId(id: string): string {
    const i = id.indexOf('/');
    return i === -1 ? id : id.slice(i + 1);
}

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
    const row = await d1
        .prepare(
            `SELECT role FROM entity_memberships
             WHERE account_id = ? AND entity_id = ? LIMIT 1`,
        )
        .bind(accountId, entityId)
        .first<{ role: string }>();
    return row?.role ?? null;
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
