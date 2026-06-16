import { z } from 'zod';
import { type AuthorizationRules } from '@djibb/protocol/auth/rules';
import { type Slot } from '@djibb/protocol/list';
/**
 * Snapshot of entity metadata as it lives in the D1 `workspace_entities`
 * read index. Per ADR 0003 the DO is authoritative; this row is a
 * derived projection emitted by the DO post-commit. The worker reads it
 * for the auth fast path and catalog queries.
 */
export declare const EntityRowSchema: z.ZodObject<{
    id: z.ZodString;
    workspace_id: z.ZodNullable<z.ZodString>;
    type: z.ZodEnum<{
        workspace: "workspace";
        list: "list";
        template: "template";
    }>;
    name: z.ZodNullable<z.ZodString>;
    description: z.ZodNullable<z.ZodString>;
    forked_from_id: z.ZodNullable<z.ZodString>;
    meta: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    slug: z.ZodString;
    slot: z.ZodNullable<z.ZodEnum<{
        personal_workspace: "personal_workspace";
        inbox: "inbox";
        seed_pool: "seed_pool";
    }>>;
    cascade_source: z.ZodNullable<z.ZodString>;
    authorization_rules: z.ZodObject<{
        authorized_accounts: z.ZodRecord<z.ZodString, z.ZodObject<{
            role: z.ZodEnum<{
                admin: "admin";
                checker: "checker";
                editor: "editor";
                owner: "owner";
                viewer: "viewer";
            }>;
        }, z.core.$strip>>;
        default_role: z.ZodEnum<{
            checker: "checker";
            editor: "editor";
            ownerless: "ownerless";
            restricted: "restricted";
            viewer: "viewer";
        }>;
        set_by: z.ZodEnum<{
            defaults: "defaults";
            user: "user";
            workspace: "workspace";
        }>;
    }, z.core.$strip>;
    time_created: z.ZodNumber;
    time_updated: z.ZodNumber;
    time_deleted: z.ZodNullable<z.ZodNumber>;
    version: z.ZodNumber;
}, z.core.$strip>;
export type EntityRow = z.infer<typeof EntityRowSchema>;
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
export declare function GetEntityVersion(d1: D1Database, id: string): Promise<number | null>;
export declare function GetEntity(d1: D1Database, id: string): Promise<EntityRow | null>;
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
export declare function defaultSlugForId(id: string): string;
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
export declare function EmitEntityMembershipsToCatalog(d1: D1Database, args: {
    entityId: string;
    authorizedAccounts: Record<string, {
        role: string;
    }>;
    timeUpdated: number;
}): Promise<void>;
/**
 * Read the role an account holds on an entity, from the D1 membership
 * projection. Returns null when no membership row exists. Used by the
 * auth resolver fast path (ADR 0011 §Step 8) — D1 is a projection so a
 * read here may briefly lag the DO; the DO mutator gates re-check the
 * authoritative rules in the same commit, so a missed membership at the
 * boundary can at worst skip a permitted action, never grant a denied
 * one.
 */
export declare function GetEntityMembershipRole(d1: D1Database, accountId: string, entityId: string): Promise<string | null>;
export declare function EmitEntitySnapshotToCatalog(d1: D1Database, snapshot: EntitySnapshot): Promise<void>;
