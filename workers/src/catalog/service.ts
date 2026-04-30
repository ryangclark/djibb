export type CatalogEntity = {
    id: string;
    type: 'list' | 'template';
    name: string | null;
};

/**
 * Owner-only catalog query. Returns entities (lists + templates) where
 * the given account is in `authorization_rules.authorized_accounts` with
 * `role = 'owner'`. Soft-deleted rows are excluded.
 *
 * Uses `json_each` to match the account by key rather than interpolating
 * the ID into the JSON path expression — account IDs contain `/`, which
 * would force quoting in `$."a/abc".role` and is fiddly to bind safely.
 */
export async function ListOwnedEntities(
    d1: D1Database,
    accountId: string,
): Promise<CatalogEntity[]> {
    const result = await d1
        .prepare(
            `SELECT we.id AS id, we.type AS type, we.name AS name
             FROM workspace_entities AS we,
                  json_each(we.authorization_rules, '$.authorized_accounts') AS aa
             WHERE we.time_deleted IS NULL
               AND aa.key = ?
               AND json_extract(aa.value, '$.role') = 'owner'
             ORDER BY we.time_updated DESC`,
        )
        .bind(accountId)
        .all<CatalogEntity>();

    return result.results ?? [];
}
