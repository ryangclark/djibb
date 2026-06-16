import { type ListElement, type ListGroup, type ListItem, type Quantity } from '@djibb/protocol/list';
import { type ReplicacheClientGroup } from '../replicache';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import type { MutationEnvelope, MutationStatus } from './mutators';
/**
 * TODO:
 * [] split this file out into files by model (in corresponding directory)
 *      (e.g. /replicache/sql.ts, /mutators/sql.ts? )
 */
/**
 * Writes an entity-typed (list or template) row to the DO sql. Per ADR
 * 0003 the DO is authoritative for every entity field — `authorization_rules`,
 * `workspace_id`, `forked_from_id` are stored on the row itself rather than
 * overlaid from D1.
 */
export declare function createElement(sql: SqlStorage, element: ListElement): void;
export declare function getElementById(sql: SqlStorage, elementId: string): {
    id: string;
    type: "list";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    id: string;
    type: "template";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    id: string;
    type: "workspace";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    child_element_refs: string[];
    id: string;
    name: string;
    parent_element_ref: string;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    type: "group";
    version: number;
    description?: string | undefined;
} | {
    id: string;
    name: string;
    parent_element_ref: string;
    references_entity_id: string | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    type: "item";
    value: {
        target_value: number;
        unit: string;
        value: number;
        max_value?: number | undefined;
        min_value?: number | undefined;
    };
    version: number;
    description?: string | undefined;
} | undefined;
/**
 * Read an element's `type` and `slot` by id, with NO type or
 * `time_deleted` filter — used by archive/unarchive/startFresh guards
 * that must observe the row regardless of its current deletion state
 * (e.g. to reject archiving a `personal_workspace`).
 */
export declare function getElementTypeAndSlot(sql: SqlStorage, elementId: string): {
    type?: string;
    slot?: string | null;
} | undefined;
/**
 * Read the CAS-relevant columns of a live entity row (a List/Template/
 * Workspace, per `ENTITY_ROW_TYPES`, not soft-deleted). Returns the
 * superset of columns the entity-scoped CAS checks consult; each caller
 * reads the one or two fields it needs. `undefined` ⇒ no live entity row
 * (callers treat as `gone`).
 */
export declare function getLiveEntityCasRow(sql: SqlStorage, entityId: string): {
    type: string;
    slot: string | null;
    name: string | null;
    description: string | null;
    authorization_rules: unknown;
    workspace_id: string | null;
} | undefined;
/**
 * Read the CAS-relevant columns of a live `workspace` row (`name` and the
 * stringified `meta` blob). `undefined` ⇒ no live workspace row.
 */
export declare function getLiveWorkspaceCasRow(sql: SqlStorage, workspaceId: string): {
    name: string | null;
    meta: unknown;
} | undefined;
/**
 * Read a live `group` row's `parent_element_ref` for reorder CAS guards.
 * `undefined` ⇒ no live group row.
 */
export declare function getLiveGroupParentRef(sql: SqlStorage, groupId: string): {
    parent_element_ref: unknown;
} | undefined;
/**
 * Read a live `item` row's CAS-relevant columns (`parent_element_ref` for
 * reorder guards, `value` for quantity guards). `undefined` ⇒ no live item
 * row.
 */
export declare function getLiveItemCasRow(sql: SqlStorage, itemId: string): {
    parent_element_ref: unknown;
    value: unknown;
} | undefined;
export declare function getChangedElements(sql: SqlStorage, previousVersion: number): ({
    id: string;
    type: "list";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    id: string;
    type: "template";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    id: string;
    type: "workspace";
    authorization_rules: {
        authorized_accounts: Record<string, {
            role: "admin" | "checker" | "editor" | "owner" | "viewer";
        }>;
        default_role: "checker" | "editor" | "ownerless" | "restricted" | "viewer";
        set_by: "defaults" | "user" | "workspace";
    };
    child_element_refs: string[];
    forked_from_id: string | null;
    meta: Record<string, unknown> | null;
    name: string;
    slot: "personal_workspace" | "inbox" | "seed_pool" | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    workspace_id: string | null;
    version: number;
    cascade_source?: string | null | undefined;
    description?: string | undefined;
    slug?: string | undefined;
} | {
    child_element_refs: string[];
    id: string;
    name: string;
    parent_element_ref: string;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    type: "group";
    version: number;
    description?: string | undefined;
} | {
    id: string;
    name: string;
    parent_element_ref: string;
    references_entity_id: string | null;
    time_created: Date;
    time_deleted: Date | null;
    time_updated: Date;
    type: "item";
    value: {
        target_value: number;
        unit: string;
        value: number;
        max_value?: number | undefined;
        min_value?: number | undefined;
    };
    version: number;
    description?: string | undefined;
})[];
/**
 * Initializes SQL tables and default values. Should only be run once
 * per list.
 * @param sql SQL client, written for Cloudflare's Durable Object
 * SQLite storage
 * @param listId ID of the List
 */
export declare function InitializeTables(sql: SqlStorage): void;
/**
 * ID of the list/template entity this DO serves. Each DO holds exactly
 * one entity row (`type IN ('list','template')`); used by alarm-driven
 * reconciliation (ADR 0007) which has no caller-supplied entityId.
 *
 * Returns null when the schema exists but holds no entity row. Throws
 * if the `list_elements` table doesn't exist at all — that's a real
 * fault in the request path (the DO is always initialized before a push
 * queries it). The alarm dispatcher guards against the schemaless case
 * up front (`alarm()` checks the schema exists), so alarm-driven callers
 * never reach here on a brand-new or self-destructed DO.
 */
export declare function getEntityId(sql: SqlStorage): string | null;
export declare function getListVersion(sql: SqlStorage): number;
export declare function setListVersion(sql: SqlStorage, version: number): void;
export declare function getReplicacheClientGroupById(sql: SqlStorage, clientGroupId: ReplicacheClientGroup['id']): {
    accountId: string | null;
    clients: {
        id: string;
        lastMutationId: number;
        lastModifiedVersion: number;
    }[];
    id: string;
} | null;
/**
 * Update an entity row's name and version. Used by `renameList`. Per
 * ADR 0003 the DO is authoritative; the post-commit emit projects the
 * new name to the D1 catalog read index.
 */
export declare function renameEntity(sql: SqlStorage, { entityId, name, version, }: {
    entityId: string;
    name: string;
    version: number;
}): void;
/**
 * Soft-delete an entity row. Used by `archiveList`. The version bump
 * makes the next pull re-emit the row; the pull handler emits a
 * `del` op for any element with `time_deleted` set, hiding the entity
 * from clients. The catalog read index also filters out soft-deleted
 * rows, so the post-commit emit removes the entity from picker results.
 *
 * Idempotent on already-archived rows: re-archive bumps `time_deleted`
 * and `version` again, which is harmless. We don't guard against
 * double-archive because doing so would surface an error for a UI
 * gesture that's effectively a no-op.
 */
export declare function archiveEntity(sql: SqlStorage, { entityId, version, cascadeSource, }: {
    entityId: string;
    version: number;
    /**
     * The Workspace ID whose cascade-archive sweep is driving this
     * archive. Set only by `cascadeArchiveList` (ADR 0008 / ADR 0011
     * §Step 10a). User-driven `archiveList` omits this; the column
     * remains NULL, which is the resting state for any entity that
     * was archived by direct user intent rather than by a parent
     * Workspace's cascade. The restore predicate in 10a.5 selects
     * `WHERE cascade_source = ?`, so a NULL row is invisible to a
     * `restoreWorkspace` sweep — preserving the user's prior
     * "archive this list" intent across an unrelated workspace
     * delete/restore cycle.
     */
    cascadeSource?: string | null;
}): void;
/**
 * Restore a soft-deleted entity row by clearing `time_deleted`. Inverse
 * of `archiveEntity` for the `unarchiveList` undo path. Idempotent on
 * already-live rows.
 *
 * Also clears `cascade_source` unconditionally. A restored entity has
 * by definition come back to life independently of whatever cascade
 * archive (if any) put it under; future cascade sweeps must not pick
 * it up under an old workspace's breadcrumb. The cascade-restore path
 * (ADR 0008 / 10a.5) calls this from a `system`-role mutator that
 * scanned by `cascade_source = ?` to find this row in the first place,
 * so clearing the breadcrumb after the read is the correct ordering.
 */
export declare function unarchiveEntity(sql: SqlStorage, { entityId, version }: {
    entityId: string;
    version: number;
}): void;
/**
 * Restore a soft-deleted workspace entity and demote its `slot` to
 * NULL. Used by `unarchiveList` per ADR 0008 §"Restoring a previously-
 * personal Workspace" / ADR 0011 §Step 10c — restoring a personal
 * workspace from Trash promotes the other current personal workspace
 * (minted by `startFresh`) and turns the restored one into an ordinary
 * team workspace. The "at most one personal workspace per account"
 * invariant is preserved automatically.
 *
 * Type-narrowed to `workspace` rows: misrouting against a list/template
 * id throws `NotFoundError`. Same shape as `unarchiveEntity` otherwise
 * (clears `time_deleted` + `cascade_source`, bumps version).
 */
export declare function unarchiveEntityAndClearSlot(sql: SqlStorage, { entityId, version }: {
    entityId: string;
    version: number;
}): void;
/**
 * Soft-delete a single item row. Idempotent — re-archiving an
 * already-deleted row just refreshes `time_deleted` and bumps
 * `version`, mirroring `archiveEntity`'s policy. Missing rows are a
 * silent no-op (unlike `archiveEntity` which throws); item archive is
 * a frequent UI gesture that shouldn't surface NotFoundError when a
 * remote delete raced the local one.
 */
export declare function archiveListItem(sql: SqlStorage, { itemId, version }: {
    itemId: string;
    version: number;
}): void;
/**
 * Restore a soft-deleted item row by clearing `time_deleted`.
 * Idempotent on already-live rows. Missing rows are a silent no-op.
 */
export declare function unarchiveListItem(sql: SqlStorage, { itemId, version }: {
    itemId: string;
    version: number;
}): void;
/** Bulk archive — applies each id independently; missing rows skipped. */
export declare function archiveListItems(sql: SqlStorage, { itemIds, version }: {
    itemIds: readonly string[];
    version: number;
}): void;
/** Bulk restore — applies each id independently; missing rows skipped. */
export declare function unarchiveListItems(sql: SqlStorage, { itemIds, version }: {
    itemIds: readonly string[];
    version: number;
}): void;
/**
 * Soft-delete a single group row. Symmetric to `archiveListItem`.
 * Does NOT cascade to child items — the cascade-on-group-delete UI
 * question (ADR 0004 §"Slice E") sits at the D.5 layer, not here.
 * Children whose `parent_element_ref` points at an archived group
 * are filtered out of the rendered tree by virtue of the parent
 * being gone; restore the group and they reappear.
 */
export declare function archiveListGroup(sql: SqlStorage, { groupId, version }: {
    groupId: string;
    version: number;
}): void;
/** Restore a soft-deleted group row by clearing `time_deleted`. */
export declare function unarchiveListGroup(sql: SqlStorage, { groupId, version }: {
    groupId: string;
    version: number;
}): void;
/** Bulk archive — applies each id independently; missing rows skipped. */
export declare function archiveListGroups(sql: SqlStorage, { groupIds, version }: {
    groupIds: readonly string[];
    version: number;
}): void;
/** Bulk restore — applies each id independently; missing rows skipped. */
export declare function unarchiveListGroups(sql: SqlStorage, { groupIds, version }: {
    groupIds: readonly string[];
    version: number;
}): void;
/**
 * Outcome of `setEntityMetaField`. `gone` means the target row is
 * missing or soft-deleted; surfaced for parity with other set-family
 * helpers. ADR 0005 §"Defensive conflict policy".
 */
export type SetMetaFieldOutcome = 'applied' | 'gone';
/**
 * Read-modify-write a single key inside an entity row's `meta` JSON
 * column. Pass `value: null` to remove the key; if removing it
 * empties the object, the whole column is set back to NULL (so the
 * "never written" and "explicitly empty" states converge).
 *
 * Type-narrowed via `entityType` so a misrouted call against the
 * wrong entity surfaces as `gone` instead of silently mutating. The
 * DO is single-threaded so the read-modify-write isn't subject to
 * race conditions within a single mutator invocation.
 *
 * Used by `setWorkspaceImage` (writes `meta.image_url`); future
 * presentation-y setters land here too. ADR 0011 §Step 5.
 */
export declare function setEntityMetaField(sql: SqlStorage, { entityId, entityType, key, value, version, }: {
    entityId: string;
    entityType: 'list' | 'template' | 'workspace';
    key: string;
    value: unknown;
    version: number;
}): SetMetaFieldOutcome;
/**
 * Update a workspace entity row's name. Symmetric to `renameEntity` but
 * type-narrowed to `workspace` rows so a misrouted `renameWorkspace`
 * against a list/template id surfaces as `NotFoundError`. Used by
 * `renameWorkspace`.
 */
export declare function renameWorkspaceEntity(sql: SqlStorage, { workspaceId, name, version, }: {
    workspaceId: string;
    name: string;
    version: number;
}): void;
/**
 * Bump the version + time_updated on a workspace entity row without
 * changing any of its content fields. Used by `setWorkspaceSlug`
 * (ADR 0011 §Step 7b.5) — the slug itself lives D1-side only, but
 * the snapshot emit downstream of a successful claim still needs a
 * version bump so the projection writer's `excluded.version >= …`
 * guard lets the row update through (refreshing time_updated, etc).
 *
 * Type-narrowed to `workspace` rows so a misrouted call against a
 * list/template id surfaces as `NotFoundError`. Returns nothing on
 * success.
 */
export declare function bumpWorkspaceVersion(sql: SqlStorage, { workspaceId, version }: {
    workspaceId: string;
    version: number;
}): void;
/**
 * Update an entity row's description. Used by `setDescription`. An
 * empty string clears the description (the column defaults to ""; we
 * don't distinguish unset from empty).
 */
export declare function setEntityDescription(sql: SqlStorage, { entityId, description, version, }: {
    entityId: string;
    description: string;
    version: number;
}): void;
/**
 * Replace an entity row's authorization_rules whole. Used by
 * `setListAuthRules`. Whole-replace is the simpler primitive; field-
 * by-field deltas can be layered on later if the UI needs them.
 *
 * Caller is responsible for any "do not lock yourself out" guards —
 * the SQL accepts whatever rules the mutator passes through. The DO
 * mutator is owner-gated (per `requiredRole`), so only an admin or
 * owner can issue this in the first place.
 */
export declare function setEntityAuthorizationRules(sql: SqlStorage, { entityId, authorization_rules, version, }: {
    entityId: string;
    authorization_rules: AuthorizationRules;
    version: number;
}): void;
/**
 * Re-point an entity row's `workspace_id` and bump its version. Used by
 * the `moveList` mutator (ADR 0011 §Phase 5 / "move a list between
 * workspaces"). `workspace_id` is a real top-level column — not a
 * `meta` key — so this mirrors `setEntityAuthorizationRules` (a
 * single-column UPDATE) rather than `setEntityMetaField`.
 *
 * Moving a list re-points its workspace-derived access grant: the
 * read-side fast path (`resolveSessionRole`) folds `workspace_id` into
 * the effective-role computation, so the post-commit catalog emit must
 * carry the new id for the list to appear under the destination
 * workspace (and disappear from the source). The push handler adds
 * `moveList` to `ENTITY_METADATA_MUTATORS` for exactly that reason.
 *
 * Type-narrowed to entity rows via `ENTITY_ROW_TYPES_SQL_LIST`; a
 * misrouted call against an item/group id writes zero rows and throws
 * `NotFoundError`.
 */
export declare function setEntityWorkspaceId(sql: SqlStorage, { entityId, workspace_id, version, }: {
    entityId: string;
    workspace_id: string;
    version: number;
}): void;
export declare function setItemValueAndVersion(sql: SqlStorage, { itemId, value, version, }: {
    itemId: string;
    value: Quantity;
    version: number;
}): void;
/**
 * Writable fields on a list item. All optional — callers pass only the
 * keys they want to change. Immutable columns (id, type, time_created)
 * and auto-managed columns (version, time_updated, time_deleted) are
 * not in this surface; archive/restore goes through a separate mutator.
 */
export type ListItemWritableFields = Partial<{
    description: string;
    name: string;
    parent_element_ref: string;
    references_entity_id: string | null;
    value: Quantity;
}>;
/**
 * Outcome of an attempted field-level update.
 *
 *  - `applied` — write landed.
 *  - `stale`   — `expected` was present and didn't match current state;
 *                the entire mutation was a no-op (CAS conflict, ADR 0005).
 *  - `gone`    — target row not found / soft-deleted.
 *
 * `stale` and `gone` are silently dropped today; B.1 wires them into
 * the per-mutation outcome channel (ADR 0006).
 */
export type FieldUpdateOutcome = 'applied' | 'stale' | 'gone';
/**
 * Field-level item update for the `setItemFields` mutator (umbrella
 * shape per ADR 0005). Replaces the previous whole-replace
 * `updateListItem` helper.
 *
 *  - `fields`   — keys to write. Only listed columns are touched;
 *                 everything else stays as-is.
 *  - `expected` — optional CAS pre-check. If present, compares each
 *                 listed key to the current row before writing; any
 *                 mismatch no-ops the entire mutation
 *                 (all-or-nothing per envelope, ADR 0005
 *                 §"Defensive conflict policy").
 */
export declare function updateListItemFields(sql: SqlStorage, { itemId, fields, expected, version, }: {
    itemId: string;
    fields: ListItemWritableFields;
    expected?: ListItemWritableFields;
    version: number;
}): FieldUpdateOutcome;
export type ItemFieldsBatchEntry = {
    itemId: string;
    fields: ListItemWritableFields;
    expected?: ListItemWritableFields;
};
/**
 * Bulk field-level item update for `setItemsAtomic`. All-or-nothing
 * across the batch: pre-checks every entry's `expected` against
 * current state, and if any mismatch (`stale`) or missing row
 * (`gone`) is found, no entries are written. ADR 0005
 * §"Defensive conflict policy" — the whole envelope is the unit.
 *
 * The DO is single-threaded so the two-pass (check-all then write-all)
 * doesn't race against itself. Replays interleaved with other mutators
 * are serialized by the DO input gate.
 */
export declare function updateListItemsFieldsAtomic(sql: SqlStorage, { entries, version, }: {
    entries: ItemFieldsBatchEntry[];
    version: number;
}): FieldUpdateOutcome;
/**
 * Writable fields on a list group. Symmetric to `ListItemWritableFields`;
 * `child_element_refs` is intentionally excluded — reorder/create/archive
 * mutators own that array (A.7 / A.4 / A.5). Auto-managed columns are
 * the same set as items.
 */
export type ListGroupWritableFields = Partial<{
    description: string;
    name: string;
    parent_element_ref: string;
}>;
/**
 * Field-level group update for the `setGroupFields` mutator. Same
 * shape as `updateListItemFields` against the `type = 'group'` row.
 */
export declare function updateListGroupFields(sql: SqlStorage, { groupId, fields, expected, version, }: {
    groupId: string;
    fields: ListGroupWritableFields;
    expected?: ListGroupWritableFields;
    version: number;
}): FieldUpdateOutcome;
export type GroupFieldsBatchEntry = {
    groupId: string;
    fields: ListGroupWritableFields;
    expected?: ListGroupWritableFields;
};
/**
 * Bulk field-level group update for `setGroupsAtomic`. Symmetric to
 * `updateListItemsFieldsAtomic` against `type = 'group'` rows.
 */
export declare function updateListGroupsFieldsAtomic(sql: SqlStorage, { entries, version, }: {
    entries: GroupFieldsBatchEntry[];
    version: number;
}): FieldUpdateOutcome;
export declare function insertListItem(sql: SqlStorage, item: ListItem): void;
/**
 * Insert a group row. Symmetric to `insertListItem` — groups and items
 * share the `list_elements` table and differ only in which columns they
 * populate (a group carries `child_element_refs`; an item carries
 * `value` / `references_entity_id`). `INSERT OR IGNORE` keeps it
 * idempotent under mutation retry, matching `insertListItem`.
 *
 * Used by the fork path (`mintFromBlank`) to copy a Blank Template's
 * groups into a freshly-minted List in one mutation; there is no
 * standalone `createListGroup` mutator yet.
 */
export declare function insertListGroup(sql: SqlStorage, group: ListGroup): void;
export declare function appendChildElementRef(sql: SqlStorage, parentId: string, childId: string): void;
/**
 * Move `childId` to `toIndex` within `parentId`'s `child_element_refs`
 * array. The id must already be in the array; cross-parent moves go
 * through `setItemFields` / `setGroupFields` (parent_element_ref).
 *
 * `expectedFromIndex` is the optional CAS guard used by undo —
 * silently no-ops if another client moved the same child in the
 * interim. Per ADR 0005's defensive policy.
 *
 * Bumps the parent's version because pull-rebase keys diffing off
 * entity-row version; without the bump the array change wouldn't
 * propagate.
 */
export declare function reorderChildElement(sql: SqlStorage, { parentId, childId, toIndex, expectedFromIndex, version, }: {
    parentId: string;
    childId: string;
    toIndex: number;
    expectedFromIndex?: number;
    version: number;
}): FieldUpdateOutcome;
export declare function setElementAsDeleted(sql: SqlStorage, elementId: string): boolean;
/**
 * Append a row to the mutation log. Envelope fields land in their own
 * columns (`account_id`, `timestamp_client`, `client_id`, `id`, `name`)
 * — they are first-class. `args` carries only the per-mutator BODY (no
 * envelope re-stuffing), stringified for the audit trail.
 */
export declare function setMutation(sql: SqlStorage, envelope: MutationEnvelope, bodyArgs: unknown, status: MutationStatus): void;
/**
 * One row of the mutation log, shaped for the audit-log read path.
 * `seq` is the SQLite rowid — an opaque, monotonically-increasing
 * insertion cursor (newer rows have larger values), used for "load
 * older" pagination without depending on clock resolution.
 *
 * `timestamp_server` is normalized to unix **seconds** here: the column
 * is written with `CURRENT_TIMESTAMP`, which SQLite stores as a UTC
 * datetime *string* despite the INTEGER affinity, so we `strftime` it
 * back to an epoch at read time. `timestamp_client` is already epoch
 * seconds (or null) as written by `setMutation`.
 */
export type MutationLogEntry = {
    seq: number;
    id: number;
    client_id: string;
    account_id: string | null;
    name: string;
    status: string;
    /**
     * The raw stringified mutation body, exactly as stored. Kept as a
     * string (not a parsed object) deliberately: Cloudflare's RPC stub
     * typing collapses `unknown` to `never` and chokes on a recursive
     * JSON type across the DO boundary, so consumers `JSON.parse` this
     * themselves. Null when the column was empty/unparseable.
     */
    args: string | null;
    timestamp_client: number | null;
    timestamp_server: number | null;
};
/**
 * Read the entity's mutation log, newest-first, for the audit-log
 * surface (ADR 0005's history table; per-entity, owner-gated at the
 * HTTP boundary). Pass the `seq` of the last row from the previous page
 * as `before` to fetch older entries. `limit` is clamped to [1, 200].
 */
export declare function getMutationLog(sql: SqlStorage, opts?: {
    limit?: number;
    before?: number | null;
}): MutationLogEntry[];
export declare function setListItemValue(sql: SqlStorage, listItem: ListItem): boolean;
export declare function setReplicacheClientGroup(sql: SqlStorage, clientGroup: ReplicacheClientGroup): void;
