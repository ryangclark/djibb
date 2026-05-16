import { z } from 'zod';

import {
    AuthorizationRules,
    AuthorizationRulesSchema,
} from '../auth/rules';
import { UnexpectedError } from '../errors';

/**
 * Snapshot of entity metadata as it lives in the D1 `workspace_entities`
 * read index. Per ADR 0003 the DO is authoritative; this row is a
 * derived projection emitted by the DO post-commit. The worker reads it
 * for the auth fast path and catalog queries.
 */
export const EntityRowSchema = z.object({
    id: z.string(),
    workspace_id: z.string().nullable(),
    type: z.enum(['list', 'template']),
    name: z.string().nullable(),
    description: z.string().nullable(),
    forked_from_id: z.string().nullable(),
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
    const parsed = EntityRowSchema.safeParse({
        id: row.id,
        workspace_id: row.workspace_id ?? null,
        type: row.type,
        name: row.name ?? null,
        description: row.description ?? null,
        forked_from_id: row.forked_from_id ?? null,
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
                    authorization_rules, time_created, time_updated,
                    time_deleted, version
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
    type: 'list' | 'template';
    name: string;
    description: string | null;
    forked_from_id: string | null;
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
export async function EmitEntitySnapshotToCatalog(
    d1: D1Database,
    snapshot: EntitySnapshot,
): Promise<void> {
    await d1
        .prepare(
            `INSERT INTO workspace_entities (
                id, workspace_id, type, name, description, forked_from_id,
                authorization_rules, time_created, time_updated,
                time_deleted, version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                name = excluded.name,
                description = excluded.description,
                forked_from_id = excluded.forked_from_id,
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
            JSON.stringify(snapshot.authorization_rules),
            snapshot.time_created,
            snapshot.time_updated,
            snapshot.time_deleted,
            snapshot.version,
        )
        .run();
}
