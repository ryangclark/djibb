import { ListElement, ListElementUnion, ListItem, ListSchema, Quantity } from '.';
import { Account } from '../account';
import {
    AuthorizationRole,
    AuthorizationRules,
    AuthorizationRulesSchema,
    AuthorizationRulesSetBy,
    AuthorizedAccountSchema,
    DefaultRole,
} from '../auth/rules';
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
    ReplicacheClientGroup,
    ReplicacheClientGroupSchema,
} from '../replicache';
import { DefaultAuthorizationRules } from './constants';
import { Mutation, MutationSchema } from './mutators';

/**
 * TODO:
 * [] split this file out into files by model (in corresponding directory)
 *      (e.g. /replicache/sql.ts, /mutators/sql.ts? )
 */

/** */
export function createElement(sql: SqlStorage, element: ListElement) {
    if (element.type === 'list') {
        // We can only have one list.
        try {
            const queryElem = getElementById(sql, element.id);

            if (queryElem) {
                throw new BadMutationError('list already exists!');
            }
        } catch (error) {
            if (error instanceof NotFoundError) {
                // no-op
            } else {
                console.log(
                    '`createElement()` unexpected error during list check:',
                    error
                );

                throw error; // passthrough
            }
        }
    }

    const cursor = sql.exec(
        `INSERT INTO list_elements (
            id,
            name,
            type,
            version
        ) VALUES (
            ?,
            ?,
            ?,
            ?
        );`,
        element.id,
        element.name,
        element.type,
        element.version
    );

    const EXPECTED_ROWS_WRITTEN = 2; // 2?
    if (cursor.rowsWritten !== EXPECTED_ROWS_WRITTEN) {
        throw new UnexpectedError(
            `\`createElement\` bad rowsWritten: want "${EXPECTED_ROWS_WRITTEN}" got "${cursor.rowsWritten}"`
        );
    }
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

// Pulls the account roles for the list.
export function getAccountsRoles(sql: SqlStorage) {
    const cursor = sql.exec(
        `SELECT id AS account_id, role FROM accounts LIMIT 100`
    );
    const accountRoles: AuthorizationRules['authorized_accounts'] = {};

    for (const row of cursor) {
        if (row['account_id'] !== 'string') {
            throw new ValidationError('invalid row["account_id"]');
        }

        const parseResult = AuthorizedAccountSchema.safeParse(row['role']);

        if (parseResult.success) {
            accountRoles[row['account_id']] = parseResult.data;
        } else {
            throw new ValidationError('invalid row["role"]');
        }
    }

    return accountRoles;
}

export function getAuthorizationRules(sql: SqlStorage): AuthorizationRules {
    try {
        const authorizationRules: AuthorizationRules = {
            authorized_accounts: getAccountsRoles(sql),
            default_role: sql
                .exec(`SELECT value FROM kv WHERE key = "auth_default_role"`)
                .one()['value'] as DefaultRole,
            set_by: sql
                .exec(`SELECT value FROM kv WHERE key = "auth_rules_set_by"`)
                .one()['value'] as AuthorizationRulesSetBy,
        };
        return authorizationRules;
    } catch (error) {
        if (error?.toString().startsWith('Error: no such table: accounts')) {
            // We aren't yet initialized, so tables don't yet exist,
            // so return defaults.

            return DefaultAuthorizationRules;
        }

        // Everything else, 500 Internal Server Error
        throw new UnexpectedError();
    }
}

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

    let data: any = result.value;

    if (result.value.type === 'list') {
        // Add list-specific info.
        data = {
            ...result.value,
            authorization_rules: getAuthorizationRules(sql),
            workspace_id:
                sql
                    .exec(`SELECT value FROM kv WHERE key = "workspace_id"`)
                    // .raw()
                    .next()?.['value']?.['value'] || null,
        };
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
        let data: any = row;

        if (row.type === 'list' || row.type === 'template') {
            // Entity-level fields that live in D1 per ADR 0001 are
            // hydrated from the DO's legacy storage for now — defaulted
            // when the DO doesn't carry them. Will be removed when the
            // entity row is dropped from list_elements entirely.
            data = {
                ...row,
                authorization_rules: getAuthorizationRules(sql),
                forked_from_id: null,
                workspace_id: sql
                    .exec(`SELECT value FROM kv WHERE key = "workspace_id"`) //
                    .one()['value'],
            };
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
            "child_element_refs" TEXT NOT NULL DEFAULT '[]',
            "description" TEXT DEFAULT "",
            "meta" TEXT DEFAULT NULL,
            "name" TEXT NOT NULL,
            "parent_element_ref" TEXT DEFAULT NULL,
            "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "time_deleted" INTEGER DEFAULT NULL,
            "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "type" TEXT NOT NULL,
            "value" TEXT DEFAULT NULL, -- this is essentially a JSON column
            "version" INTEGER NOT NULL
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
            "id" INTEGER NOT NULL PRIMARY KEY,      -- Mutation ID is integer and matches List version
            "account_id" TEXT DEFAULT NULL,         -- ID of the Account responsible for the mutation, if any
            "args" TEXT DEFAULT NULL,               -- Stringified arguments for the mutation, if applicable
            "client_id" TEXT DEFAULT NULL,          -- ID of the Replicache client, if applicable
            -- "client_group_id" TEXT DEFAULT NULL, -- ID of the Replicache Client Group, if applicable
            "name" TEXT NOT NULL,                   -- Mutation name
            "status" TEXT NOT NULL,                 -- Status of the mutation
            -- "timestamp_client" INTEGER DEFAULT NULL, -- not doing this for now... it'll be in "args" if necessary
            "timestamp_server" INTEGER NOT NULL
            -- "profile_id" TEXT DEFAULT NULL       -- ID of the Replicache browser profile, if applicable
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

    // TODO: create an INIT_WORKSPACE_ID or SET_WORKSPACE_ID or whatever, and trigger it it early on

    // Initialize KV with defaults values.
    sql.exec(
        `INSERT INTO kv VALUES
        ("auth_default_role", "ownerless"),
        ("auth_rules_set_by", "defaults"),
        ("schema_version", "2"),
        ("workspace_id", NULL);`
    );

    // Init the members table, which stores each account that
    // is affiliated with this list as a row.
    sql.exec(
        `CREATE TABLE IF NOT EXISTS accounts(
            "id" TEXT NOT NULL PRIMARY KEY,
            "flags" TEXT DEFAULT NULL,
            "role" TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_id
        ON accounts(id);`
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

export function getListVersion(sql: SqlStorage) {
    const cursor = sql.exec(
        `SELECT version
        FROM list_elements
        WHERE type = "list"
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
        WHERE type = "list"`,
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

export function setAuthorizedAccount(
    sql: SqlStorage,
    accountId: Account['id'],
    accountFlags: Record<string, any> | null,
    authorizedRole: AuthorizationRole
) {
    // to be clear, i have no idea if this thing rips
    sql.exec(
        `INSERT INTO accounts(id, flags, role)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            flags=excluded.flags,
            role=excluded.role;`,
        accountId,
        JSON.stringify(accountFlags),
        authorizedRole
    );
}

export function setAuthorizationDefaultRole(
    sql: SqlStorage,
    defaultRole: AuthorizationRole,
    setBy: AuthorizationRules['set_by']
) {
    const parseResult = AuthorizationRulesSchema.pick({
        default_role: true,
    }).safeParse(defaultRole);

    if (!parseResult.success) {
        console.log(
            '`setAuthorizationDefaultRole()` parse error:',
            parseResult.error.format()
        );
        throw new ValidationError();
    }

    sql.exec(
        `UPDATE kv SET value = ? WHERE key = "auth_default_role";
         UPDATE kv SET value = ? WHERE key = "auth_rules_set_by";`,
        defaultRole,
        setBy
    );
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

// General-purpose item update for the `setItem` mutator. Only touches
// editable columns — time_created and type are locked at insert time.
export function updateListItem(sql: SqlStorage, item: ListItem): void {
    const cursor = sql.exec(
        `UPDATE list_elements
        SET
            description = ?,
            name = ?,
            parent_element_ref = ?,
            value = ?,
            version = ?,
            time_updated = CURRENT_TIMESTAMP
        WHERE id = ?
            AND type = 'item'
            AND time_deleted IS NULL;`,
        item.description ?? '',
        item.name,
        item.parent_element_ref,
        JSON.stringify(item.value),
        item.version,
        item.id
    );

    if (cursor.rowsWritten !== 1) {
        throw new NotFoundError(
            `\`updateListItem()\` item "${item.id}" not found (rowsWritten=${cursor.rowsWritten})`
        );
    }
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
            time_created,
            time_updated,
            type,
            value,
            version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        item.id,
        item.name,
        item.parent_element_ref,
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
            AND time_deleted = null`,
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

export function setMutation(sql: SqlStorage, mutation: Mutation) {
    if (!mutation.status) {
        throw new ValidationError('missing/invalid mutation.status');
    }

    try {
        // Could do a verification query.
        // This would be expected to return no rows:
        // sql.exec('SELECT * FROM mutations WHERE id = ?', mutation.id)

        const cursor = sql.exec(
            `INSERT INTO mutations (
                id,
                account_id,
                args,
                client_id, -- not sure if this is relevant
                name,
                status,
                -- timestamp_client,
                timestamp_server
            ) VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                -- ?,
                CURRENT_TIMESTAMP
            );`,
            mutation.id,
            mutation.args.accountId,
            JSON.stringify(mutation.args),
            mutation.clientID,
            mutation.name,
            mutation.status
        );

        const EXPECTED_ROWS_WRITTEN = 1;
        if (cursor.rowsWritten !== EXPECTED_ROWS_WRITTEN) {
            console.log(
                `\`setMutation()\` error: bad rowsWritten got ${cursor.rowsWritten} want ${EXPECTED_ROWS_WRITTEN}`
            );

            throw new UnexpectedError();
        }
    } catch (error) {
        // TODO: remove
        if (
            error?.toString() ===
            'Error: table mutations has no column named status: SQLITE_ERROR'
        ) {
            throw error;
        }

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
