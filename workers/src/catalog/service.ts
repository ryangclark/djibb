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
 * the account is a member of; the type filter here keeps those out
 * of the picker.
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

/**
 * One row in the per-account Trash. Carries enough to render a row
 * (`name`, `type`, `time_deleted`) and to wire a Restore button
 * (`id`). `slug` is included because workspaces in the Trash that the
 * user wants to restore need the slug to route back to once live;
 * lists/templates URL by id and ignore the field.
 *
 * `cascade_source` is intentionally exposed: clients want to render
 * "(cascade-deleted with workspace X)" affordances for any future
 * Trash UI variant. For 10b-ui itself we only show entities with
 * `cascade_source IS NULL` (the SQL filter below), so the field is
 * always null in the response — but typing it now means the API shape
 * doesn't break when 10c-or-later wants to surface cascade rows too.
 */
export type TrashedEntity = {
    id: string;
    type: 'list' | 'template' | 'workspace';
    name: string | null;
    slug: string;
    time_deleted: number; // unix seconds, non-null by SQL filter
    time_updated: number;
    cascade_source: string | null;
};

/**
 * Owner-only Trash query per ADR 0008 / ADR 0011 §Step 10b-ui. Returns
 * soft-deleted entities the account owns:
 *
 *   - Workspaces are always included when soft-deleted. The user
 *     restores the workspace; cascade-restore (10a.5) fans out to
 *     bring back the children that were cascade-archived under it.
 *   - Lists/templates are included only when `cascade_source IS NULL`
 *     — i.e. the user archived them directly. Cascade-archived
 *     children (their `cascade_source` points at a workspace) are
 *     excluded because they'll come back automatically when the
 *     parent workspace is restored; showing them in Trash would
 *     create confusing per-row Restore actions that race the
 *     workspace-level restore sweep.
 *
 * Owner filter goes through the `entity_memberships` projection
 * (`role = 'owner'`) rather than scanning the rules JSON, matching the
 * pattern in `GetWorkspacesByAccountId` (workspace/service.ts) and
 * benefiting from the (account_id, entity_id) primary key index.
 * Ordered by `time_deleted DESC` so the most recently trashed lands
 * at the top — that's where the user looks first after an
 * "oh, I shouldn't have deleted that" moment.
 */
export async function ListTrashedEntitiesForAccount(
    d1: D1Database,
    accountId: string,
): Promise<TrashedEntity[]> {
    const result = await d1
        .prepare(
            `SELECT we.id, we.type, we.name, we.slug,
                    we.time_deleted, we.time_updated, we.cascade_source
             FROM entity_memberships em
             JOIN workspace_entities we ON we.id = em.entity_id
             WHERE em.account_id = ?
               AND em.role = 'owner'
               AND we.time_deleted IS NOT NULL
               AND (we.type = 'workspace' OR we.cascade_source IS NULL)
             ORDER BY we.time_deleted DESC`,
        )
        .bind(accountId)
        .all<TrashedEntity>();
    return result.results ?? [];
}
