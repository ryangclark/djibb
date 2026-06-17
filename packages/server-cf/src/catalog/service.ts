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

/**
 * One entity shared *with* the actor — a list or template they hold a
 * direct grant on. `role` is their granted role; `slug` is carried for
 * symmetry with other catalog rows (lists/templates URL by id).
 */
export type SharedEntity = {
    id: string;
    type: 'list' | 'template';
    name: string | null;
    slug: string;
    role: string;
    time_updated: number; // unix seconds
};

/**
 * ADR 0009 §"Shared with me — v1 D1, end-state DO". The recipient's
 * surface for finding entities granted to them directly — Bob's way back
 * to "Weekend BBQ" after he accepts Alice's invite (§Independent grant
 * axes). This is the v1 D1-index implementation; the end-state
 * (Account-as-DjibbList) is the substrate question ADR 0013 deferred.
 *
 * Returns lists/templates where the account has a *granted* entity-direct
 * role, excluding:
 *   - `owner` — that's the account's own entity, surfaced elsewhere.
 *   - `restricted` (pre-accept invite state) and `ownerless` (bootstrap
 *     artifact) — not real access.
 *   - workspaces (`type`) — those are the switcher's job.
 *   - entities inside a workspace the account already belongs to — they
 *     show in that workspace's views, so listing them here would
 *     double-count. (Independent grant axes: a direct grant is only
 *     "shared with me" when workspace membership doesn't already cover
 *     it.)
 * Soft-deleted targets are excluded; newest-updated first.
 */
export async function ListSharedWithAccount(
    d1: D1Database,
    accountId: string,
): Promise<SharedEntity[]> {
    const result = await d1
        .prepare(
            `SELECT we.id, we.type, we.name, we.slug, em.role,
                    we.time_updated
             FROM entity_memberships em
             JOIN workspace_entities we ON we.id = em.entity_id
             WHERE em.account_id = ?
               AND we.type IN ('list', 'template')
               AND we.time_deleted IS NULL
               AND em.role NOT IN ('owner', 'restricted', 'ownerless')
               AND (we.workspace_id IS NULL OR we.workspace_id NOT IN (
                     SELECT em2.entity_id
                     FROM entity_memberships em2
                     WHERE em2.account_id = ?
                   ))
             ORDER BY we.time_updated DESC`,
        )
        .bind(accountId, accountId)
        .all<SharedEntity>();
    return result.results ?? [];
}

/**
 * One pending invitation addressed to a verified identity the actor
 * holds. Carries enough to render a row and link to the entity's accept
 * surface: `target_id` URLs lists/templates (`/l/<id>`, `/t/<id>`),
 * `slug` URLs workspaces (`/w/<slug>`), and `role` names what accepting
 * grants. `time_expires` lets the UI show "expires in N days".
 */
export type PendingInvitation = {
    id: string; // invitation id, 'inv/<suffix>'
    target_id: string;
    target_type: 'list' | 'template' | 'workspace';
    name: string | null;
    slug: string | null;
    role: string;
    inviter_account_id: string;
    time_created: number; // unix seconds
    time_expires: number; // unix seconds
};

/**
 * ADR 0009 §Recipient discovery — the `/invitations` inbox half of the
 * dual surface (the entity-page `InviteBanner` is the other half). Lists
 * pending, unexpired invitations whose `identity_value` is one of the
 * caller's verified emails, so a recipient who lost the invite email can
 * still find and accept it.
 *
 * Keyed by identity (not account_id): invitations are pre-membership and
 * live in `entity_invitations_index` keyed by the invited email, exactly
 * as `ResolveInvitedWorkspaceBySlug` (workspace/service.ts) matches them.
 * Accept itself stays per-account — the `acceptInvitation` DO mutator
 * does the authoritative identity-ownership check at accept time, so this
 * read only needs to be good enough to surface the row. Soft-deleted
 * targets are excluded; ordered newest-first.
 */
export async function ListPendingInvitationsForIdentities(
    d1: D1Database,
    {
        identityValues,
        nowSeconds,
    }: { identityValues: string[]; nowSeconds: number },
): Promise<PendingInvitation[]> {
    if (identityValues.length === 0) return [];
    const placeholders = identityValues.map(() => '?').join(', ');
    const result = await d1
        .prepare(
            `SELECT ei.id AS id, ei.target_id AS target_id,
                    ei.target_type AS target_type, ei.role AS role,
                    ei.inviter_account_id AS inviter_account_id,
                    ei.time_created AS time_created,
                    ei.time_expires AS time_expires,
                    we.name AS name, we.slug AS slug
             FROM entity_invitations_index ei
             JOIN workspace_entities we ON we.id = ei.target_id
             WHERE ei.status = 'pending'
               AND ei.identity_kind = 'email'
               AND ei.time_expires > ?
               AND ei.identity_value IN (${placeholders})
               AND we.time_deleted IS NULL
             ORDER BY ei.time_created DESC`,
        )
        .bind(nowSeconds, ...identityValues)
        .all<PendingInvitation>();
    return result.results ?? [];
}
