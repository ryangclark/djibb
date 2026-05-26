export type CatalogEntity = {
    id: string;
    type: 'list' | 'template' | 'workspace';
    name: string | null;
};

/**
 * Owner-only catalog query. Returns entities (lists + templates) where
 * the given account is in `authorization_rules.authorized_accounts` with
 * `role = 'owner'`. Soft-deleted rows are excluded.
 *
 * Excludes workspaces (`type = 'workspace'`): this query powers the
 * lists/templates picker, which surfaces *contents* of a workspace,
 * not the workspaces themselves. The workspace switcher (ADR 0011
 * §Step 9) will get its own endpoint that lists workspace entities
 * the account is a member of. ADR 0011 §Step 6 introduced workspace
 * entities into this table via personal-workspace dual-write; this
 * filter is what keeps that out of the picker.
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
               AND we.type IN ('list', 'template')
               AND aa.key = ?
               AND json_extract(aa.value, '$.role') = 'owner'
             ORDER BY we.time_updated DESC`,
        )
        .bind(accountId)
        .all<CatalogEntity>();

    return result.results ?? [];
}
