import {
    ENTITY_ROW_TYPES_SQL_LIST,
    isEntityRow,
    isEntityRowType,
    type ListElement,
    ListElementUnion,
    type ListItem,
    ListSchema,
    type Quantity,
} from '.';
import {
    BadMutationError,
    DjibbError,
    NotFoundError,
    ParseError,
    TablesAlreadyInitializedError,
    UnexpectedError,
    ValidationError,
} from '../errors';
import {
    type ReplicacheClientGroup,
    ReplicacheClientGroupSchema,
} from '../replicache';
import type { AuthorizationRules } from '../auth/rules';
import { DefaultAuthorizationRules } from './constants';
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
export function createElement(sql: SqlStorage, element: ListElement) {
    if (!isEntityRow(element)) {
        throw new BadMutationError(
            `\`createElement()\` not supported for type "${element.type}"`
        );
    }

    // Idempotency: a duplicate init must not throw. We reject only if a
    // row exists with a *different* shape (which would indicate a real
    // bug, not a retry).
    try {
        const existing = getElementById(sql, element.id);
        if (existing) {
            return;
        }
    } catch (error) {
        if (!(error instanceof NotFoundError)) {
            throw error;
        }
    }

    sql.exec(
        `INSERT INTO list_elements (
            id,
            authorization_rules,
            child_element_refs,
            description,
            forked_from_id,
            meta,
            name,
            slot,
            time_created,
            time_updated,
            type,
            version,
            workspace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        element.id,
        JSON.stringify(element.authorization_rules),
        JSON.stringify(element.child_element_refs),
        element.description ?? '',
        element.forked_from_id,
        element.meta ? JSON.stringify(element.meta) : null,
        element.name,
        element.slot,
        Math.floor(element.time_created.getTime() / 1000),
        Math.floor(element.time_updated.getTime() / 1000),
        element.type,
        element.version,
        element.workspace_id
    );
}

// export async function getChangedEntries(
//     executor: Executor,
//     spaceID: string,
//     prevVersion: number
// ): Promise<[key: string, value: string, deleted: boolean][]> {
//     // changes are only in the onverlay space, so we do not need to
//     // query the base space.
//     const { rows } = await executor(
//         `select key, value, deleted from entry where spaceid = $1 and version > $2`,
//         [spaceID, prevVersion]
//     );
//     return rows.map(row => [row.key, row.value, row.deleted]);
// }

export function getElementById(sql: SqlStorage, elementId: string) {
    const cursor = sql.exec(
        `SELECT *
        FROM list_elements
        WHERE id = ?
        LIMIT 1`,
        elementId
    );

    let result = cursor.next();

    if (result.done) {
        // query returned zero results
        // TODO: umm this sucks
        return undefined;
    }

    // let parseResult;

    let data: any = { ...result.value };

    // time_* columns are stored as unix seconds; the schema's
    // z.coerce.date() treats numbers as milliseconds, so convert here.
    if (typeof data.time_created === 'number') data.time_created *= 1000;
    if (typeof data.time_updated === 'number') data.time_updated *= 1000;
    if (typeof data.time_deleted === 'number') data.time_deleted *= 1000;

    // Entity-level fields are stored on the DO row per ADR 0003. Parse
    // them out of their TEXT columns; tolerate nulls for legacy rows.
    if (isEntityRowType(data.type)) {
        data.authorization_rules = data.authorization_rules
            ? JSON.parse(data.authorization_rules)
            : DefaultAuthorizationRules;
        data.workspace_id = data.workspace_id ?? null;
        data.forked_from_id = data.forked_from_id ?? null;
        // `slot` column is recent (ADR 0011); older DO storage may omit
        // it entirely. Treat undefined and null the same.
        data.slot = data.slot ?? null;
        // `cascade_source` column is recent (ADR 0008, ADR 0011 §Step
        // 10a.4a); older DO storage may omit it. Treat undefined and
        // null the same — at rest, every entity is `null`.
        data.cascade_source = data.cascade_source ?? null;
        // `meta` is a stringified JSON blob (ADR 0011 §Step 5). Parse
        // on the way out; tolerate `null` (column default) and the
        // empty-string seen on some legacy DO rows.
        data.meta =
            data.meta && typeof data.meta === 'string'
                ? JSON.parse(data.meta)
                : null;
    }

    // Default `references_entity_id` to null for items: column is recent;
    // older DO storage and direct-SQL seeds may omit it.
    if (data.type === 'item' && data.references_entity_id === undefined) {
        data.references_entity_id = null;
    }

    data.child_element_refs = JSON.parse(data.child_element_refs);
    data.value = JSON.parse(data.value);

    const parseResult = ListElementUnion.safeParse(data);

    if (!parseResult.success) {
        console.log(
            `\`getElementById()\` parse error for "${elementId}":`,
            parseResult.error.format()
        );
        console.log('parsedValue:', data);
        throw new ParseError();
    }

    return parseResult.data;
}

// Queries the database for entries with a version greater than the
// given version.
export function getChangedElements(sql: SqlStorage, previousVersion: number) {
    const result = [];

    // I don't know if this throws? Where do we get db/query errors?
    const cursor = sql.exec(
        `SELECT *
        FROM list_elements
        WHERE version > ?`,
        previousVersion
    );

    // Validate each row coming out of the db.
    // Ideally, we wouldn't have to do this because we would be
    // validating prior to writing and could therefore safely
    // assume data integrity.
    //
    // For now, though, it'll surely catch some mistakes.
    for (const row of cursor) {
        let data: any = { ...row };

        if (typeof data.time_created === 'number') data.time_created *= 1000;
        if (typeof data.time_updated === 'number') data.time_updated *= 1000;
        if (typeof data.time_deleted === 'number') data.time_deleted *= 1000;

        if (isEntityRowType(row.type)) {
            data.authorization_rules = data.authorization_rules
                ? JSON.parse(data.authorization_rules as string)
                : DefaultAuthorizationRules;
            data.workspace_id = data.workspace_id ?? null;
            data.forked_from_id = data.forked_from_id ?? null;
            data.slot = data.slot ?? null;
            data.cascade_source = data.cascade_source ?? null;
            data.meta =
                data.meta && typeof data.meta === 'string'
                    ? JSON.parse(data.meta)
                    : null;
        }

        // Default `references_entity_id` to null for items: column is recent;
        // older DO storage and direct-SQL seeds may omit it.
        if (data.type === 'item' && data.references_entity_id === undefined) {
            data.references_entity_id = null;
        }

        data.child_element_refs = JSON.parse(data.child_element_refs);
        data.value = JSON.parse(data.value);

        const parseResult = ListElementUnion.safeParse(data);

        if (!parseResult.success) {
            console.log(
                '`getChangedElements()` invalid `list_elements` row error:',
                parseResult.error.format(),
                'row:',
                row
            );

            throw new ValidationError('invalid `list_elements` row');
        }

        result.push(parseResult.data);
    }

    return result;
}

// TODO: create indexes for many of these tables!

/**
 * Initializes SQL tables and default values. Should only be run once
 * per list.
 * @param sql SQL client, written for Cloudflare's Durable Object
 * SQLite storage
 * @param listId ID of the List
 */
export function InitializeTables(
    sql: SqlStorage
    // {
    //     clientCreatedTimestamp,
    //     listId,
    //     workspaceId,
    // }: {
    //     listId: string;
    //     clientCreatedTimestamp: Date | null;
    //     workspaceId: string | null;
    // }
) {
    // Check if we have already initialized.
    let isInitialized = false;
    try {
        const cursor = sql.exec(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='list_elements';`
        );

        let rawResult = cursor.raw().next();

        isInitialized = !rawResult.done;
    } catch (error) {
        console.error(`query error during initialization check`, error);
        throw new UnexpectedError();
    }

    if (isInitialized) {
        throw new TablesAlreadyInitializedError();
    }

    // Query returned zero results, which is expected.
    console.log('INITIALIZING TABLES!!');

    // Initialize list elements table, where each list element,
    // whether an item or a group of items, is stored as a row.
    sql.exec(
        `CREATE TABLE IF NOT EXISTS list_elements(
            "id" TEXT NOT NULL PRIMARY KEY,
            "authorization_rules" TEXT DEFAULT NULL, -- JSON, entity rows only (ADR 0003)
            "cascade_source" TEXT DEFAULT NULL, -- entity rows only; set by cascade-archive mutations (ADR 0008, ADR 0011 §Step 10a)
            "child_element_refs" TEXT NOT NULL DEFAULT '[]',
            "description" TEXT DEFAULT "",
            "forked_from_id" TEXT DEFAULT NULL, -- entity rows only
            "meta" TEXT DEFAULT NULL, -- entity rows only; JSON blob (ADR 0011 §Step 5)
            "name" TEXT NOT NULL,
            "parent_element_ref" TEXT DEFAULT NULL,
            "references_entity_id" TEXT DEFAULT NULL,
            "slot" TEXT DEFAULT NULL, -- entity rows only; see ADR 0011 / SlotEnum
            "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "time_deleted" INTEGER DEFAULT NULL,
            "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "type" TEXT NOT NULL,
            "value" TEXT DEFAULT NULL, -- this is essentially a JSON column
            "version" INTEGER NOT NULL,
            "workspace_id" TEXT DEFAULT NULL -- entity rows only
        );`
    );

    /**
     * LLM-suggested indexes:
     *
     * Useful if you're querying or joining based on parent_element_ref (e.g., getting all children of a parent).
     *      CREATE INDEX idx_list_elements_parent_ref ON list_elements(parent_element_ref);
     *
     * Speeds up queries that filter out deleted rows (WHERE time_deleted IS NULL), which is common in soft-delete patterns
     *      CREATE INDEX idx_list_elements_not_deleted ON list_elements(time_deleted);
     *
     * Helps if you're syncing or filtering based on recent changes, such as in replication or audit logic.
     *      CREATE INDEX idx_list_elements_updated_version ON list_elements(time_updated, version);
     */

    // Initialize the Mutations table, which stores actions as a
    // running history of the list.
    // NOTE: there's a lot of Replicache-specific columns here; please
    // reevaluate which are needed after some time.

    sql.exec(
        `CREATE TABLE IF NOT EXISTS mutations(
            "id" INTEGER NOT NULL,                  -- Per-client mutation ID (Replicache assigns these monotonically per client)
            "client_id" TEXT NOT NULL,              -- ID of the Replicache client that authored the mutation
            "account_id" TEXT DEFAULT NULL,         -- Account ID from the mutation envelope, if any
            "args" TEXT DEFAULT NULL,               -- Stringified BODY args (envelope fields are NOT stored here; they have their own columns)
            "name" TEXT NOT NULL,                   -- Mutation name
            "status" TEXT NOT NULL,                 -- Status of the mutation
            "timestamp_client" INTEGER DEFAULT NULL,-- Envelope-level client clock at mutation authorship (unix seconds). Nullable for offline-queued mutations missing it.
            "timestamp_server" INTEGER NOT NULL,    -- Server clock when the mutation was logged (unix seconds)
            PRIMARY KEY (client_id, id)             -- mutation IDs are unique per client, not per DO
        );`
    );

    // Initialize key-value table, which allows us to store arbitrary
    // values, just like a key-value store.
    sql.exec(
        `CREATE TABLE IF NOT EXISTS kv(
            "key" TEXT NOT NULL PRIMARY KEY,
            "value" TEXT DEFAULT NULL
        );`
    );

    // Initialize KV with defaults values. Entity-level metadata is on
    // the entity's own list_elements row per ADR 0003.
    sql.exec(
        `INSERT INTO kv VALUES
        ("schema_version", "7");`
    );

    sql.exec(
        `CREATE TABLE IF NOT EXISTS replicache_client_groups(
            "id" TEXT NOT NULL PRIMARY KEY,
            "account_id" TEXT DEFAULT NULL,
            "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`
    );

    sql.exec(
        `CREATE TABLE IF NOT EXISTS replicache_clients(
            "id" TEXT NOT NULL PRIMARY KEY,
            "client_group_id" TEXT NOT NULL,
            "last_modified_version" INTEGER NOT NULL,
            "last_mutation_id" INTEGER NOT NULL
        )`
    );

    // TODO: do the above tables need indexes??
}

// function createMutation(sql: SqlStorage, mutation: Mutation) {
//     const parseResult = MutationSchema.safeParse(mutation);

//     if (!parseResult.success) {
//         console.error(
//             '`createMutation()` parse error:',
//             parseResult.error.format()
//         );
//         throw new ParseError();
//     }

//     const columnsToValues = {
//         account_id: mutation.accountId,
//         args: mutation.args,
//         client_id: mutation.clientID,
//         id: mutation.id,
//         name: mutation.name,
//         timestamp_client: mutation.timestamp_client
//             ? Math.floor(mutation.timestamp_client.getTime() / 1000)
//             : null,
//         timestamp_server: Math.floor(
//             mutation.timestamp_server.getTime() / 1000
//         ),
//     };

//     const keysArr = Object.keys(columnsToValues);

//     sql.exec(
//         `INSERT INTO mutations (
//             ${keysArr.join(', ')}
//         ) VALUES (
//             ${new Array(keysArr.length).fill('?').join(', ')}
//         )`,
//         Object.values(columnsToValues)
//     );
// }

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
export function getEntityId(sql: SqlStorage): string | null {
    const cursor = sql.exec(
        `SELECT id
        FROM list_elements
        WHERE type IN (${ENTITY_ROW_TYPES_SQL_LIST})
        LIMIT 1;`
    );

    const result = cursor.next();
    if (result.done) return null;

    const id = result.value['id'];
    return typeof id === 'string' ? id : null;
}

export function getListVersion(sql: SqlStorage) {
    const cursor = sql.exec(
        `SELECT version
        FROM list_elements
        WHERE type IN (${ENTITY_ROW_TYPES_SQL_LIST})
        LIMIT 1;`
    );

    let result = cursor.next();

    if (result.done) {
        // TODO: remove log
        console.log('`getListVersion()` no list; returning 0');

        // query returned zero results
        return 0;
    }

    // This is worrisome? It'll throw...
    return ListSchema.shape.version.parse(result.value['version']);
}

// TODO: ensure this runs with every mutation!
export function setListVersion(sql: SqlStorage, version: number) {
    ListSchema.shape.version.parse(version);

    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            time_updated = CURRENT_TIMESTAMP,
            version = ?
        WHERE type IN (${ENTITY_ROW_TYPES_SQL_LIST})`,
        version
    );

    // TODO: should be able to remove this after things are stable
    if (cursor.rowsWritten !== 1) {
        console.error(
            '`setListVersion()` rowsWritten got %d wanted %d',
            cursor.rowsWritten,
            1
        );
    }
}

export function getReplicacheClientGroupById(
    sql: SqlStorage,
    clientGroupId: ReplicacheClientGroup['id']
) {
    const cursorGroup = sql.exec(
        `SELECT account_id
        FROM replicache_client_groups
        WHERE id = ?`,
        clientGroupId
    );

    const nextRow = cursorGroup.next();
    if (nextRow.done) {
        return null;
    }

    const result = {
        accountId: nextRow.value['account_id'],
        clients: [] as any, // we zod parse all this later anyway...
        cvrVersion: nextRow.value['cvr_version'],
        id: clientGroupId,
    };

    // Populate the `clients` property.
    const cursorClients = sql.exec(
        `SELECT id, last_mutation_id, last_modified_version
        FROM replicache_clients
        WHERE client_group_id = ?`,
        clientGroupId
    );

    for (const row of cursorClients) {
        result.clients.push({
            id: row['id'],
            lastMutationId: row['last_mutation_id'],
            lastModifiedVersion: row['last_modified_version'],
        });
    }

    return ReplicacheClientGroupSchema.parse(result);
}

/**
 * Update an entity row's name and version. Used by `renameList`. Per
 * ADR 0003 the DO is authoritative; the post-commit emit projects the
 * new name to the D1 catalog read index.
 */
export function renameEntity(
    sql: SqlStorage,
    {
        entityId,
        name,
        version,
    }: { entityId: string; name: string; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            name = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
            AND time_deleted IS NULL;`,
        name,
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`renameEntity()\` entity "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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
export function archiveEntity(
    sql: SqlStorage,
    {
        entityId,
        version,
        cascadeSource,
    }: {
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
    }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            time_deleted = CURRENT_TIMESTAMP,
            cascade_source = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type IN (${ENTITY_ROW_TYPES_SQL_LIST});`,
        cascadeSource ?? null,
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`archiveEntity()\` entity "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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
export function unarchiveEntity(
    sql: SqlStorage,
    { entityId, version }: { entityId: string; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            time_deleted = NULL,
            cascade_source = NULL,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type IN (${ENTITY_ROW_TYPES_SQL_LIST});`,
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`unarchiveEntity()\` entity "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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
export function unarchiveEntityAndClearSlot(
    sql: SqlStorage,
    { entityId, version }: { entityId: string; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            time_deleted = NULL,
            cascade_source = NULL,
            slot = NULL,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = 'workspace';`,
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`unarchiveEntityAndClearSlot()\` workspace "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

/**
 * Soft-delete a single item row. Idempotent — re-archiving an
 * already-deleted row just refreshes `time_deleted` and bumps
 * `version`, mirroring `archiveEntity`'s policy. Missing rows are a
 * silent no-op (unlike `archiveEntity` which throws); item archive is
 * a frequent UI gesture that shouldn't surface NotFoundError when a
 * remote delete raced the local one.
 */
export function archiveListItem(
    sql: SqlStorage,
    { itemId, version }: { itemId: string; version: number }
): void {
    sql.exec(
        `UPDATE list_elements
         SET
             time_deleted = CURRENT_TIMESTAMP,
             version = ?,
             time_updated = CURRENT_TIMESTAMP
         WHERE id = ? AND type = 'item';`,
        version,
        itemId
    );
}

/**
 * Restore a soft-deleted item row by clearing `time_deleted`.
 * Idempotent on already-live rows. Missing rows are a silent no-op.
 */
export function unarchiveListItem(
    sql: SqlStorage,
    { itemId, version }: { itemId: string; version: number }
): void {
    sql.exec(
        `UPDATE list_elements
         SET
             time_deleted = NULL,
             version = ?,
             time_updated = CURRENT_TIMESTAMP
         WHERE id = ? AND type = 'item';`,
        version,
        itemId
    );
}

/** Bulk archive — applies each id independently; missing rows skipped. */
export function archiveListItems(
    sql: SqlStorage,
    { itemIds, version }: { itemIds: readonly string[]; version: number }
): void {
    for (const itemId of itemIds) {
        archiveListItem(sql, { itemId, version });
    }
}

/** Bulk restore — applies each id independently; missing rows skipped. */
export function unarchiveListItems(
    sql: SqlStorage,
    { itemIds, version }: { itemIds: readonly string[]; version: number }
): void {
    for (const itemId of itemIds) {
        unarchiveListItem(sql, { itemId, version });
    }
}

/**
 * Soft-delete a single group row. Symmetric to `archiveListItem`.
 * Does NOT cascade to child items — the cascade-on-group-delete UI
 * question (ADR 0004 §"Slice E") sits at the D.5 layer, not here.
 * Children whose `parent_element_ref` points at an archived group
 * are filtered out of the rendered tree by virtue of the parent
 * being gone; restore the group and they reappear.
 */
export function archiveListGroup(
    sql: SqlStorage,
    { groupId, version }: { groupId: string; version: number }
): void {
    sql.exec(
        `UPDATE list_elements
         SET
             time_deleted = CURRENT_TIMESTAMP,
             version = ?,
             time_updated = CURRENT_TIMESTAMP
         WHERE id = ? AND type = 'group';`,
        version,
        groupId
    );
}

/** Restore a soft-deleted group row by clearing `time_deleted`. */
export function unarchiveListGroup(
    sql: SqlStorage,
    { groupId, version }: { groupId: string; version: number }
): void {
    sql.exec(
        `UPDATE list_elements
         SET
             time_deleted = NULL,
             version = ?,
             time_updated = CURRENT_TIMESTAMP
         WHERE id = ? AND type = 'group';`,
        version,
        groupId
    );
}

/** Bulk archive — applies each id independently; missing rows skipped. */
export function archiveListGroups(
    sql: SqlStorage,
    { groupIds, version }: { groupIds: readonly string[]; version: number }
): void {
    for (const groupId of groupIds) {
        archiveListGroup(sql, { groupId, version });
    }
}

/** Bulk restore — applies each id independently; missing rows skipped. */
export function unarchiveListGroups(
    sql: SqlStorage,
    { groupIds, version }: { groupIds: readonly string[]; version: number }
): void {
    for (const groupId of groupIds) {
        unarchiveListGroup(sql, { groupId, version });
    }
}

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
export function setEntityMetaField(
    sql: SqlStorage,
    {
        entityId,
        entityType,
        key,
        value,
        version,
    }: {
        entityId: string;
        entityType: 'list' | 'template' | 'workspace';
        key: string;
        value: unknown;
        version: number;
    }
): SetMetaFieldOutcome {
    const rows = sql
        .exec(
            `SELECT meta FROM list_elements
             WHERE id = ?
               AND type = ?
               AND time_deleted IS NULL;`,
            entityId,
            entityType
        )
        .toArray();
    const row = rows[0];
    if (!row) return 'gone';

    const current: Record<string, unknown> =
        row.meta && typeof row.meta === 'string'
            ? JSON.parse(row.meta as string)
            : {};
    if (value === null || value === undefined) {
        delete current[key];
    } else {
        current[key] = value;
    }
    const nextMeta =
        Object.keys(current).length === 0 ? null : JSON.stringify(current);

    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            meta = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = ?
            AND time_deleted IS NULL;`,
        nextMeta,
        version,
        entityId,
        entityType
    );
    return cursor.rowsWritten === 1 ? 'applied' : 'gone';
}

/**
 * Update a workspace entity row's name. Symmetric to `renameEntity` but
 * type-narrowed to `workspace` rows so a misrouted `renameWorkspace`
 * against a list/template id surfaces as `NotFoundError`. Used by
 * `renameWorkspace`.
 */
export function renameWorkspaceEntity(
    sql: SqlStorage,
    {
        workspaceId,
        name,
        version,
    }: { workspaceId: string; name: string; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            name = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = 'workspace'
            AND time_deleted IS NULL;`,
        name,
        version,
        workspaceId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`renameWorkspaceEntity()\` workspace "${workspaceId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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
export function bumpWorkspaceVersion(
    sql: SqlStorage,
    { workspaceId, version }: { workspaceId: string; version: number },
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = 'workspace'
            AND time_deleted IS NULL;`,
        version,
        workspaceId,
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`bumpWorkspaceVersion()\` workspace "${workspaceId}" not found (rowsWritten=${cursor.rowsWritten})`,
        );
    }
}

/**
 * Update an entity row's description. Used by `setDescription`. An
 * empty string clears the description (the column defaults to ""; we
 * don't distinguish unset from empty).
 */
export function setEntityDescription(
    sql: SqlStorage,
    {
        entityId,
        description,
        version,
    }: { entityId: string; description: string; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            description = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
            AND time_deleted IS NULL;`,
        description,
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`setEntityDescription()\` entity "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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
export function setEntityAuthorizationRules(
    sql: SqlStorage,
    {
        entityId,
        authorization_rules,
        version,
    }: {
        entityId: string;
        authorization_rules: AuthorizationRules;
        version: number;
    }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            authorization_rules = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
            AND time_deleted IS NULL;`,
        JSON.stringify(authorization_rules),
        version,
        entityId
    );
    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`setEntityAuthorizationRules()\` entity "${entityId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

// Narrow UPDATE for item value + version bumps. Used by the
// `setItemQuantity` mutator path.
export function setItemValueAndVersion(
    sql: SqlStorage,
    {
        itemId,
        value,
        version,
    }: { itemId: string; value: Quantity; version: number }
): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            value = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = 'item'
            AND time_deleted IS NULL;`,
        JSON.stringify(value),
        version,
        itemId
    );

    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`setItemValueAndVersion()\` item "${itemId}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
}

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

// JSON-stringify roundtrip used by CAS comparison. Stable for the
// shapes stored in list_elements (primitives, null, Quantity object).
function eq(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

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
export function updateListItemFields(
    sql: SqlStorage,
    {
        itemId,
        fields,
        expected,
        version,
    }: {
        itemId: string;
        fields: ListItemWritableFields;
        expected?: ListItemWritableFields;
        version: number;
    }
): FieldUpdateOutcome {
    if (Object.keys(fields).length === 0) return 'applied';

    if (expected && Object.keys(expected).length > 0) {
        const rows = sql
            .exec(
                `SELECT description, name, parent_element_ref,
                        references_entity_id, value
                 FROM list_elements
                 WHERE id = ?
                   AND type = 'item'
                   AND time_deleted IS NULL;`,
                itemId
            )
            .toArray();
        if (rows.length === 0) return 'gone';
        const row = rows[0] as Record<string, unknown>;
        for (const [k, v] of Object.entries(expected)) {
            // `value` is JSON-encoded in the column; everything else is
            // a primitive comparable as-is.
            const current =
                k === 'value' && typeof row[k] === 'string'
                    ? JSON.parse(row[k] as string)
                    : row[k];
            if (!eq(current, v)) return 'stale';
        }
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if ('description' in fields) {
        setClauses.push('description = ?');
        params.push(fields.description ?? '');
    }
    if ('name' in fields) {
        setClauses.push('name = ?');
        params.push(fields.name);
    }
    if ('parent_element_ref' in fields) {
        setClauses.push('parent_element_ref = ?');
        params.push(fields.parent_element_ref);
    }
    if ('references_entity_id' in fields) {
        setClauses.push('references_entity_id = ?');
        params.push(fields.references_entity_id);
    }
    if ('value' in fields) {
        setClauses.push('value = ?');
        params.push(JSON.stringify(fields.value));
    }
    setClauses.push('version = ?', 'time_updated = CURRENT_TIMESTAMP');
    params.push(version);
    params.push(itemId);

    const cursor = sql.exec(
        `UPDATE list_elements SET ${setClauses.join(', ')}
         WHERE id = ?
           AND type = 'item'
           AND time_deleted IS NULL;`,
        ...params
    );
    return cursor.rowsWritten === 1 ? 'applied' : 'gone';
}

// Read the CAS-relevant columns for one item by id. Returns `null`
// when the row is missing / soft-deleted. Used by bulk pre-checks.
function readItemForCAS(
    sql: SqlStorage,
    itemId: string
): Record<string, unknown> | null {
    const rows = sql
        .exec(
            `SELECT description, name, parent_element_ref,
                    references_entity_id, value
             FROM list_elements
             WHERE id = ?
               AND type = 'item'
               AND time_deleted IS NULL;`,
            itemId
        )
        .toArray();
    return rows.length === 0 ? null : (rows[0] as Record<string, unknown>);
}

function checkItemCAS(
    row: Record<string, unknown>,
    expected: ListItemWritableFields
): boolean {
    for (const [k, v] of Object.entries(expected)) {
        const current =
            k === 'value' && typeof row[k] === 'string'
                ? JSON.parse(row[k] as string)
                : row[k];
        if (!eq(current, v)) return false;
    }
    return true;
}

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
export function updateListItemsFieldsAtomic(
    sql: SqlStorage,
    {
        entries,
        version,
    }: {
        entries: ItemFieldsBatchEntry[];
        version: number;
    }
): FieldUpdateOutcome {
    if (entries.length === 0) return 'applied';

    // Pass 1: CAS pre-check every entry that has `expected`. Any
    // mismatch bails the whole batch.
    for (const entry of entries) {
        if (!entry.expected || Object.keys(entry.expected).length === 0) {
            continue;
        }
        const row = readItemForCAS(sql, entry.itemId);
        if (!row) return 'gone';
        if (!checkItemCAS(row, entry.expected)) return 'stale';
    }

    // Pass 2: apply all writes. `expected` is now redundant — already
    // checked — so call the single-update helper without it.
    for (const entry of entries) {
        const outcome = updateListItemFields(sql, {
            itemId: entry.itemId,
            fields: entry.fields,
            version,
        });
        // Only `gone` is possible here (row deleted between passes —
        // impossible in a single-threaded DO call). Defensive return.
        if (outcome !== 'applied') return outcome;
    }
    return 'applied';
}

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
export function updateListGroupFields(
    sql: SqlStorage,
    {
        groupId,
        fields,
        expected,
        version,
    }: {
        groupId: string;
        fields: ListGroupWritableFields;
        expected?: ListGroupWritableFields;
        version: number;
    }
): FieldUpdateOutcome {
    if (Object.keys(fields).length === 0) return 'applied';

    if (expected && Object.keys(expected).length > 0) {
        const rows = sql
            .exec(
                `SELECT description, name, parent_element_ref
                 FROM list_elements
                 WHERE id = ?
                   AND type = 'group'
                   AND time_deleted IS NULL;`,
                groupId
            )
            .toArray();
        if (rows.length === 0) return 'gone';
        const row = rows[0] as Record<string, unknown>;
        for (const [k, v] of Object.entries(expected)) {
            if (!eq(row[k], v)) return 'stale';
        }
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if ('description' in fields) {
        setClauses.push('description = ?');
        params.push(fields.description ?? '');
    }
    if ('name' in fields) {
        setClauses.push('name = ?');
        params.push(fields.name);
    }
    if ('parent_element_ref' in fields) {
        setClauses.push('parent_element_ref = ?');
        params.push(fields.parent_element_ref);
    }
    setClauses.push('version = ?', 'time_updated = CURRENT_TIMESTAMP');
    params.push(version);
    params.push(groupId);

    const cursor = sql.exec(
        `UPDATE list_elements SET ${setClauses.join(', ')}
         WHERE id = ?
           AND type = 'group'
           AND time_deleted IS NULL;`,
        ...params
    );
    return cursor.rowsWritten === 1 ? 'applied' : 'gone';
}

function readGroupForCAS(
    sql: SqlStorage,
    groupId: string
): Record<string, unknown> | null {
    const rows = sql
        .exec(
            `SELECT description, name, parent_element_ref
             FROM list_elements
             WHERE id = ?
               AND type = 'group'
               AND time_deleted IS NULL;`,
            groupId
        )
        .toArray();
    return rows.length === 0 ? null : (rows[0] as Record<string, unknown>);
}

function checkGroupCAS(
    row: Record<string, unknown>,
    expected: ListGroupWritableFields
): boolean {
    for (const [k, v] of Object.entries(expected)) {
        if (!eq(row[k], v)) return false;
    }
    return true;
}

export type GroupFieldsBatchEntry = {
    groupId: string;
    fields: ListGroupWritableFields;
    expected?: ListGroupWritableFields;
};

/**
 * Bulk field-level group update for `setGroupsAtomic`. Symmetric to
 * `updateListItemsFieldsAtomic` against `type = 'group'` rows.
 */
export function updateListGroupsFieldsAtomic(
    sql: SqlStorage,
    {
        entries,
        version,
    }: {
        entries: GroupFieldsBatchEntry[];
        version: number;
    }
): FieldUpdateOutcome {
    if (entries.length === 0) return 'applied';

    for (const entry of entries) {
        if (!entry.expected || Object.keys(entry.expected).length === 0) {
            continue;
        }
        const row = readGroupForCAS(sql, entry.groupId);
        if (!row) return 'gone';
        if (!checkGroupCAS(row, entry.expected)) return 'stale';
    }

    for (const entry of entries) {
        const outcome = updateListGroupFields(sql, {
            groupId: entry.groupId,
            fields: entry.fields,
            version,
        });
        if (outcome !== 'applied') return outcome;
    }
    return 'applied';
}

// Idempotent: replayed mutations (the server's per-client mutation ID
// tracking is currently incorrect, so pushes can be replayed) are a
// no-op instead of a UNIQUE violation.
export function insertListItem(sql: SqlStorage, item: ListItem): void {
    sql.exec(
        `INSERT OR IGNORE INTO list_elements (
            id,
            name,
            parent_element_ref,
            references_entity_id,
            time_created,
            time_updated,
            type,
            value,
            version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        item.id,
        item.name,
        item.parent_element_ref,
        item.references_entity_id,
        Math.floor(item.time_created.getTime() / 1000),
        Math.floor(item.time_updated.getTime() / 1000),
        item.type,
        JSON.stringify(item.value),
        item.version
    );
}

export function appendChildElementRef(
    sql: SqlStorage,
    parentId: string,
    childId: string
): void {
    const row = sql
        .exec(
            `SELECT child_element_refs
            FROM list_elements
            WHERE id = ? AND time_deleted IS NULL
            LIMIT 1;`,
            parentId
        )
        .next();

    if (row.done) {
        throw new NotFoundError(
            `\`appendChildElementRef()\` parent "${parentId}" not found`
        );
    }

    const raw = row.value['child_element_refs'];
    const refs: string[] = raw ? JSON.parse(raw as string) : [];
    if (refs.includes(childId)) return;

    refs.push(childId);

    sql.exec(
        `UPDATE list_elements
        SET child_element_refs = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?;`,
        JSON.stringify(refs),
        parentId
    );
}

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
export function reorderChildElement(
    sql: SqlStorage,
    {
        parentId,
        childId,
        toIndex,
        expectedFromIndex,
        version,
    }: {
        parentId: string;
        childId: string;
        toIndex: number;
        expectedFromIndex?: number;
        version: number;
    }
): FieldUpdateOutcome {
    const rows = sql
        .exec(
            `SELECT child_element_refs FROM list_elements
             WHERE id = ? AND time_deleted IS NULL;`,
            parentId
        )
        .toArray();
    const row = rows[0];
    if (!row) return 'gone';

    const raw = row['child_element_refs'];
    const refs: string[] = raw ? JSON.parse(raw as string) : [];
    const fromIndex = refs.indexOf(childId);
    if (fromIndex === -1) return 'gone';

    if (expectedFromIndex !== undefined && fromIndex !== expectedFromIndex) {
        return 'stale';
    }

    // Clamp target into [0, len - 1]. After splice-remove the array is
    // one shorter; clamp to the post-remove length minus one.
    const removed = [...refs];
    removed.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, removed.length));
    if (clamped === fromIndex) return 'applied'; // no-op move

    removed.splice(clamped, 0, childId);

    sql.exec(
        `UPDATE list_elements
         SET child_element_refs = ?,
             version = ?,
             time_updated = CURRENT_TIMESTAMP
         WHERE id = ?;`,
        JSON.stringify(removed),
        version,
        parentId
    );
    return 'applied';
}

// I don't know how this function might be used yet.
// Expect changes.
//
// Consider:
// - Should we require that the element not be *already* deleted?
export function setElementAsDeleted(
    sql: SqlStorage,
    elementId: string
    // mutation: Mutation
) {
    const cursor = sql.exec(
        `UPDATE list_elements SET
            time_deleted = CURRENT_TIMESTAMP
        WHERE id = ?
            AND time_deleted IS NULL`,
        elementId
        // mutation.timestamp_server
    );

    // Not sure the best way to determine if the query result was
    // empty for an UPDATE query... This is the docs way of doing it
    // for a SELECT:
    // let rawResult = cursor.raw().next();
    // if (rawResult.done) {
    // }

    // if (cursor.rowsWritten !== 1) {
    //     throw new Error(
    //         `\`setElementAsDeleted()\` query error: expected \`rowsWritten\` to be "1", got "${cursor.rowsWritten}"`
    //     );
    // }

    const EXPECTED_ROWS_WRITTEN = 1;

    return cursor.rowsWritten === EXPECTED_ROWS_WRITTEN;

    // I think you'd call `createMutation` directly, no?
    // A deletion is a "side effect" of a mutation, so it
    // shouldn't trigger `createMutation`.
    // createMutation(sql, mutation);
}

/**
 * Append a row to the mutation log. Envelope fields land in their own
 * columns (`account_id`, `timestamp_client`, `client_id`, `id`, `name`)
 * — they are first-class. `args` carries only the per-mutator BODY (no
 * envelope re-stuffing), stringified for the audit trail.
 */
export function setMutation(
    sql: SqlStorage,
    envelope: MutationEnvelope,
    bodyArgs: unknown,
    status: MutationStatus
) {
    if (!status) {
        throw new ValidationError('missing/invalid mutation status');
    }

    const timestampClientSec = envelope.timestamp_client
        ? Math.floor(envelope.timestamp_client.getTime() / 1000)
        : null;

    try {
        sql.exec(
            `INSERT INTO mutations (
                id,
                client_id,
                account_id,
                args,
                name,
                status,
                timestamp_client,
                timestamp_server
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP);`,
            envelope.id,
            envelope.clientID,
            envelope.accountId,
            JSON.stringify(bodyArgs ?? {}),
            envelope.name,
            status,
            timestampClientSec
        );
    } catch (error) {
        console.log('`setMutation()` query error:', error);
        throw new UnexpectedError();
    }
}

export function setListItemValue(sql: SqlStorage, listItem: ListItem) {
    // Lots of this will need to be stringified, no?
    // const cursor = sql.exec(
    //     `UPDATE list_elements SET
    //         child_element_refs = ?,
    //         description = ?,
    //         name = ?,
    //         parent_element_ref = ?,
    //         time_created = ?, -- not sure about this, should be checked before write, no?
    //         time_updated = ?,
    //         type = ?,
    //         value = ?,
    //         version = ?
    //     WHERE id = ?
    //         AND time_deleted = null`
    let stringified = '';
    try {
        stringified = JSON.stringify(listItem.value);
    } catch (error) {
        console.error(
            "`setListItemValue()` error stringifying list item's value:",
            error
        );
        throw new UnexpectedError();
    }

    const cursor = sql.exec(
        `UPDATE list_elements SET
            time_updated = CURRENT_TIMESTAMP,
            value = ?
        WHERE id = ?
            AND time_deleted = null;`,
        stringified,
        listItem.id
    );

    const EXPECTED_ROWS_WRITTEN = 1;

    return cursor.rowsWritten === EXPECTED_ROWS_WRITTEN;
}

export function setReplicacheClientGroup(
    sql: SqlStorage,
    clientGroup: ReplicacheClientGroup
) {
    // TODO: once auth is wired through push, UPDATE account_id when a
    // previously-anonymous group becomes associated with an account.
    sql.exec(
        `INSERT OR IGNORE INTO replicache_client_groups (id, account_id)
        VALUES (?, ?);`,
        clientGroup.id,
        clientGroup.accountId
    );

    for (const client of clientGroup.clients) {
        const updateCursor = sql.exec(
            `UPDATE replicache_clients
            SET last_modified_version = ?, last_mutation_id = ?
            WHERE id = ?;`,
            client.lastModifiedVersion,
            client.lastMutationId,
            client.id
        );

        console.log(
            '`setReplicacheClientGroup()` UPDATE query rowsWritten:',
            updateCursor.rowsWritten,
            'expected:',
            0 // would expect 1 if we already had the client in the DB
        );

        if (updateCursor.rowsWritten === 0) {
            // Assume there was no row to update, so it's a new client.
            // Insert it.
            const insertCursor = sql.exec(
                `INSERT INTO replicache_clients (
                    id,
                    client_group_id,
                    last_modified_version,
                    last_mutation_id
                ) VALUES (
                    ?, ?, ?, ?
                );`,
                client.id,
                clientGroup.id,
                client.lastModifiedVersion,
                client.lastMutationId
            );

            const EXPECTED_ROWS_WRITTEN = 1;
            if (insertCursor.rowsWritten !== EXPECTED_ROWS_WRITTEN) {
                console.log(
                    '`setReplicacheClientGroup()` INSERT query rowsWritten - got:',
                    insertCursor.rowsWritten,
                    'expected:',
                    EXPECTED_ROWS_WRITTEN
                );
                // console.log(
                //     'insertCursor.rowsWritten',
                //     insertCursor.rowsWritten
                // );
                // throw new UnexpectedError('replicache client not inserted');
            }
        }
    }
}
