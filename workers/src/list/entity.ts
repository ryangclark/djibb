import { z } from 'zod';

import {
    AuthorizationRules,
    AuthorizationRulesSchema,
} from '../auth/rules';
import { UnexpectedError } from '../errors';

/**
 * Authoritative entity metadata. Lives in the D1 `workspace_entities`
 * table per ADR 0001. The DO holds a kv mirror.
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

export type InsertEntityArgs = {
    id: string;
    workspace_id: string | null;
    type: 'list' | 'template';
    name?: string | null;
    description?: string | null;
    forked_from_id?: string | null;
    authorization_rules: AuthorizationRules;
    time_created: number;
};

/**
 * Idempotent on `id`. Used by the worker-orchestrated init reconciliation:
 * the first push that arrives for a fresh entity inserts the canonical
 * row, and any retry of the same push is a no-op.
 *
 * Returns the row as it now exists in D1 (whether just-inserted or
 * pre-existing).
 */
export async function InsertEntityIfMissing(
    d1: D1Database,
    args: InsertEntityArgs,
): Promise<EntityRow> {
    await d1
        .prepare(
            `INSERT OR IGNORE INTO workspace_entities (
                id, workspace_id, type, name, description, forked_from_id,
                authorization_rules, time_created, time_updated, version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
            args.id,
            args.workspace_id,
            args.type,
            args.name ?? null,
            args.description ?? null,
            args.forked_from_id ?? null,
            JSON.stringify(args.authorization_rules),
            args.time_created,
            args.time_created,
        )
        .run();

    const row = await GetEntity(d1, args.id);
    if (!row) {
        // Insert succeeded (or was ignored) but the row is gone? Should
        // be impossible without an external race that deleted it.
        throw new UnexpectedError();
    }
    return row;
}
