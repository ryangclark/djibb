# Workspaces

Design doc for the Workspaces feature. Captures ground-truth decisions so we don't re-litigate them while building. Updated as decisions change.

## What a workspace is

A **workspace** organizes accounts into a shared space so they can collaborate on lists. Think Slack workspace or Google Drive shared folder. Every account has exactly one **personal workspace** (Slack's DM-to-self equivalent) plus zero or more **shared workspaces**.

- A user has one or more **accounts** (OAuth identities); a single session can have multiple authed accounts.
- Each account is a member of its personal workspace and any shared workspaces it's been added to.
- Access to a workspace gives scoped access to every list the workspace contains.

## Slots: well-known entity roles

Several entities in djibb fill *well-known roles* rather than being
arbitrary user-created content: an account's personal workspace, an
account's notification inbox, the global Seed Pool, the future Trash
view / Templates library / "shared with me" index. They share a
shape — "*the* something for someone (or for everyone)" — and they
need consistent behavior: hidden from normal catalog UI, lifecycle
constraints (often un-deletable or auto-re-spawning), well-known
lookup.

Rather than encode each as its own boolean (`is_personal`, `system`,
`is_seed_pool`, …) accumulating on the entity row, every entity
carries a single nullable `slot` column — a string discriminator
that names the well-known role the entity fills:

```
SlotEnum = z.enum([
    'personal_workspace',  // type: 'workspace', exactly one per account
    'inbox',               // type: 'list', exactly one per account
    'seed_pool',           // type: 'list', exactly one globally
    // future: 'trash_view', 'templates_library', 'shared_with_me', ...
]).nullable();
```

`slot IS NULL` is the default — a regular user-created entity. The
column lives on the unified entity row (DO authoritative, D1 derived
index per ADR 0003) and applies to *every* `type` (`list`,
`template`, `workspace`).

**`slot` is purpose, not control.** The column says what the entity
is *for*, not who manages it. A user could in principle create their
own "secondary inbox" — same purpose, same hidden semantics, but
user-mutated — and it would still carry `slot: 'inbox'`. Who can
mutate the entity is determined by
`authorization_rules.authorized_accounts`, the same way it is for
every other entity.

**Lookup pattern.** Per-account slots have a pointer column on the
account row (`personal_workspace_id`, `inbox_entity_id`) for the
fast path; the `slot` column on the entity row is the integrity
guard ("the workspace this account points at really does claim to
be its personal one"). Global slots (e.g. Seed Pool) get a small
`system_entities` D1 table keyed on `slot`.

**What collapses by introducing this:**

- `is_personal: boolean` (originally proposed in the table below)
  is dropped; "this is a personal workspace" becomes
  `slot === 'personal_workspace'`.
- The inbox List (forthcoming) doesn't need its own boolean; it's
  `slot === 'inbox'`.
- Seed Pool stops being a find-by-convention magic-ID lookup; it's
  `slot === 'seed_pool'`.
- UI catalog-hiding is a single predicate everywhere:
  `slot IS NULL`.
- Lifecycle rules ("cannot delete the personal workspace,"
  "Start Fresh re-spawns it") become a slot-keyed dispatch table
  instead of `if (is_personal && ...)` checks sprawling across
  mutators.

The rest of this doc continues to use the phrase **"personal
workspace"** as user-facing language; on the schema and mutator
side, that phrase resolves to `type === 'workspace' && slot ===
'personal_workspace'`.

## Data model

> **Target vs transitional.** Under Workspace-as-DjibbList, the
> *authoritative* workspace state lives on the workspace's DO sql:
> the entity row (`name`, `slug`, `slot`, `flags`, `image`,
> timestamps, `time_deleted`, `cascade_source`) and the workspace's
> `authorization_rules` (which carries `authorized_accounts` —
> membership). D1's `workspace_entities` is the derived read index
> per ADR 0003. The standalone `AccountWorkspace` and
> `workspace_invitations` tables described below are **transitional**
> — preserved during the migration so the current D1-rows world keeps
> working, retired once membership + invitations move into the DO.

### `workspaces` (D1, derived index → `workspace_entities`)

Today the row lives in `workspaces`; under the target architecture
it lives in `workspace_entities` (the unified entity catalog) and the
fields below become emit-on-mutation columns the workspace DO
populates. Schema is otherwise as below — listed here so the
migration target is clear. Changes vs. current
`0001_create_user_and_session_tables.sql`:

| column         | type / notes                                                             |
|----------------|--------------------------------------------------------------------------|
| id             | TEXT PK, prefixed nanoid (`w/...`, 22 chars)                             |
| slug           | TEXT NOT NULL UNIQUE — **new**, URL-safe `[a-z0-9-]{3,40}`, lowercase    |
| name           | TEXT NULL — **changed**: no longer UNIQUE, now nullable, free-text (emoji OK — SQLite TEXT is UTF-8) |
| slot           | TEXT NULL — **new**, well-known role (see §Slots). `'personal_workspace'` marks the owner's personal workspace; NULL for ordinary user-created workspaces. |
| flags          | TEXT NULL, JSON bag                                                      |
| image          | TEXT NULL                                                                |
| time_created   | INTEGER NOT NULL                                                         |
| time_updated   | INTEGER NOT NULL                                                         |
| time_deleted   | INTEGER NULL (soft delete)                                               |

**`slug` is the URL segment.** URLs use `/w/:slug/...`. Renames are allowed; no redirect table in v1 (old URLs 404, UI warns).

**`name` is the display name.** Free text including emoji. Personal workspaces default to `"<account.display_name>'s space"` if `display_name` exists, otherwise NULL. When NULL + `slot = 'personal_workspace'`, the frontend picks a label ("Your Space", "Scratchpad", etc.).

**`slot = 'personal_workspace'` invariants** (enforced in service layer, not SQL): exactly one per account, exactly one owner, never more than one member, cannot be shared, cannot be deleted, cannot receive invites.

### `AccountWorkspace` (D1, transitional)

Existing table; **retires when membership moves into the workspace
DO's `authorization_rules.authorized_accounts`.** During the
transition, this table remains the source of truth for membership
reads; after migration, `account_authorizations` (ADR 0009) is the
derived index queries hit, populated by the workspace DO's emit
path.

One row per membership.

| column        | type / notes                                         |
|---------------|------------------------------------------------------|
| account_id    | TEXT NOT NULL → accounts(id)                         |
| workspace_id  | TEXT NOT NULL → workspaces(id)                       |
| role          | TEXT NOT NULL — `owner` \| `admin` \| `member` \| `viewer` |
| permissions   | TEXT NULL, JSON array of Clerk-style permission strings — reserved for future |
| time_joined   | INTEGER NOT NULL — **new**                           |
| PK            | (account_id, workspace_id)                           |

### `workspace_invitations` (D1, transitional — superseded by ADR 0009)

> **Status:** Will not be built in the shape originally specified
> below. The unified invitation flow from ADR 0009 — pending invite
> rows resident in the target entity's own DO, surfaced through a
> role-gated pull keyspace — applies to Workspace the same way it
> applies to List and Template. Once `DjibbWorkspace` exists, a
> workspace invitation is a row in the workspace DO's
> `pending_invites/*` keyspace, not a row in this table.
>
> The schema below is preserved for historical context (it informed
> ADR 0009's design) but it should not be implemented as a new D1
> table. The `link`-type invitation use case — "send this to your
> team's Slack" — is captured separately as an open item against
> ADR 0009; current ADR 0009 covers `email` + `username` targeting.

Single table with discriminator. Stores pending invites server-side.

| column              | type / notes                                                           |
|---------------------|------------------------------------------------------------------------|
| id                  | TEXT PK, prefixed nanoid                                               |
| workspace_id        | TEXT NOT NULL → workspaces(id)                                         |
| type                | TEXT NOT NULL — `email` \| `username` \| `link`                        |
| target_email        | TEXT NULL (required when type=`email`)                                 |
| target_account_id   | TEXT NULL (required when type=`username`)                              |
| role                | TEXT NOT NULL — role to grant on accept                                |
| token               | TEXT NOT NULL UNIQUE — opaque random string, appears in invite URL     |
| inviter_account_id  | TEXT NOT NULL → accounts(id)                                           |
| status              | TEXT NOT NULL — `pending` \| `accepted` \| `revoked` \| `expired`      |
| max_uses            | INTEGER NULL — for `link` type only; NULL = unlimited                  |
| use_count           | INTEGER NOT NULL DEFAULT 0                                             |
| time_created        | INTEGER NOT NULL                                                       |
| time_expires        | INTEGER NOT NULL — 7 days after creation by default                    |
| time_accepted       | INTEGER NULL                                                           |

### `lists.workspace_id`

Already exists on the DO-stored list (nullable). Every list belongs to exactly one workspace (the owner's personal workspace by default, any shared workspace after move). NULL means "orphaned / legacy" — we'll migrate existing NULL lists to point at the creator's personal workspace during rollout.

## Roles and permissions

> **Open under Workspace-as-DjibbList:** today's `WorkspaceRoleEnum`
> (`owner | admin | member | viewer`) is *narrower* than the entity
> `AuthorizationRoleEnum` (`owner | editor | viewer | restricted`).
> If membership becomes an entry in the workspace DO's
> `authorized_accounts`, the role enum has to be the same one Lists
> and Templates use. The natural collapse:
> `admin → owner`, `member → editor`, `viewer → viewer`. The
> `admin`-vs-`owner` distinction (multi-owner; admin can invite
> but not delete-workspace) doesn't survive the collapse cleanly —
> we either widen `AuthorizationRoleEnum` to add an `admin` tier
> (cost: every entity-level role check has to think about it) or
> we encode "can delete this entity" as a per-mutator capability
> check distinct from role tier. Settling this is a prerequisite
> for the migration and warrants a dedicated ADR slice. Original
> 4-tier table preserved below for the legacy shape:

Workspace roles (legacy 4-tier — narrower than `AccountRoleEnum`; ontologically related but distinct):

| role   | can do                                                                                    |
|--------|--------------------------------------------------------------------------------------------|
| owner  | everything, incl. delete workspace, transfer ownership, change admins, remove any member  |
| admin  | invite/remove members, create/delete lists, change member roles (except owner), edit workspace settings |
| member | create lists, edit any workspace list                                                      |
| viewer | read-only                                                                                  |

**Multiple owners allowed.** At least one owner required (service-layer check).

**`permissions` JSON bag** is Clerk-style (`ws:member`, `ws:items:read`, `ws:<resource>:<action>`) and is reserved for future custom permissions. For v1, role is canonical — `permissions` exists in the schema but is always empty/unused.

## List access resolution (CSS-specificity model)

When a request hits `list_app`, auth middleware resolves a role for the request by checking, in order of precedence (highest wins):

1. **Explicit list role** — `authorization_rules.authorized_accounts[account_id].role` on the list itself.
2. **Workspace role** — if the list has `workspace_id` set AND any of the session's accounts is a member of that workspace, use that account's workspace role (translated to an `AuthorizationRole`).
3. **Default role** — `authorization_rules.default_role` on the list.

Role translation workspace→list: `owner/admin → editor`, `member → editor`, `viewer → viewer`. (Refine when we have more list-level operations that warrant owner-style capabilities at the workspace level.)

**Multi-account resolution.** When multiple accounts in a session match different access paths for the same list, the active-account mechanism (see UX section) picks which account's access is used. This replaces the existing "throw UnexpectedError on multi-account conflict" stub in `list_app`.

## Moving lists between workspaces

A list's `workspace_id` can be changed. Rules:

- Actor must be at least **admin** in the source workspace AND at least **member** in the destination workspace (or owner of both).
- Moving into a personal workspace is allowed only if the destination is the actor's own personal workspace.
- Moving out of a personal workspace is allowed.
- Cross-workspace sharing is not supported (a list belongs to exactly one workspace).

## Personal workspaces

Auto-created on account creation (fills the TODO in `account/service.ts::CreateAccount`).

- `slot = 'personal_workspace'`, single owner = the account.
- `name`: `"<display_name>'s space"` if `display_name` exists, else NULL.
- `slug`: generated from `user_name` if present, else from a random suffix (`personal-<8char>`). Uniqueness checked + retry on collision.
- Cannot be deleted, cannot have its `slot` value changed, cannot receive invitations, cannot have additional members added.
- Lists live there by default until the user moves them to a shared workspace.

## Lifecycle operations

### Create workspace
- Requires authed session. Creator's active account becomes the sole owner.
- Request body supplies `name`, `slug`. Server validates slug format + uniqueness.
- Creator is inserted into `AccountWorkspace` as `owner` in the same D1 batch.

### Update workspace (name, slug, image)
- Owner or admin.
- Slug rename allowed; no redirect table; UI warns.
- Personal workspaces: slug/name editable by the owner; `slot` is immutable.

### Delete workspace (soft)
- Owner only. Non-personal workspaces only.
- Soft delete via `time_deleted`. **Cascades** to soft-delete all lists in the workspace (sets `lists.time_deleted` on the DO-stored list rows). Members can no longer access.
- Undelete is out-of-scope for v1 — requires a support path.

### Leave workspace (self-service)
- Any member can leave.
- **If the leaver is the last owner, the action is blocked** with a "transfer ownership first" error.
- Personal workspaces cannot be left.

### Transfer ownership
- Explicit action: source owner picks a target member; target is atomically promoted to `owner`; source is demoted to `admin` (configurable — v1 demotes to `admin` but keeps the option open).
- TODO: require email-based confirmation from the target before the swap. Not in v1.

## Invitations

Single table, three types. All three expire in 7 days by default.

| type     | target                               | uses                | signup-capable |
|----------|--------------------------------------|---------------------|----------------|
| email    | a specific email address             | single              | yes            |
| username | a specific djibb account             | single              | no (account already exists) |
| link     | anyone with the URL                  | `max_uses` or ∞     | yes            |

Sent/managed by **owners or admins only**.

**Accept flow.** The invitee visits `/invites/:token`. If they are not signed in, the invite can act as a signup entry point. If they have a session with multiple accounts, they explicitly pick which account accepts. On accept: `AccountWorkspace` row inserted, invitation marked `accepted`, use_count incremented (for link type; for single-use types the invitation is terminal).

**Token format.** Opaque random string (nanoid, ~22 chars). Server-side state is authoritative — we are not using stateless signed tokens for v1. Benefits: easy revoke, audit trail, idempotent accept semantics.

**Link-type invitations.** Useful for "send this to your team's Slack." Carries role + expiry + max_uses + inviter_account_id. Revokable.

## Endpoints (workers)

> **Under Workspace-as-DjibbList**, almost all of the rows below
> become **Replicache mutations on the workspace DO** rather than
> dedicated HTTP endpoints — the same way `renameList`,
> `setListAuthRules`, `archiveList` etc. became mutations once
> ADR 0003 landed. The only HTTP endpoints that survive are the
> ones that can't be expressed as a mutation on a single DO: the
> discovery/catalog query (`GET /account/:id/workspaces` reads the
> derived D1 index) and any future cross-workspace ops. The
> invitation rows (`POST/GET/DELETE /workspace/:slug/invitations*`
> and `/invitations/:token*`) collapse onto the ADR 0009 unified
> flow; see that ADR for the in-DO row + accept-banner shape.
>
> The table below names the *operations*; under the target each is
> a mutator name (e.g. `createWorkspace`, `inviteWorkspaceMember`,
> `transferWorkspaceOwnership`) registered on `DjibbWorkspace`'s
> mutator registry.

All require authed session (via `HandleSession` middleware) except where noted. Mutation handlers pull the actor's account from the session, not the request body.

| method  | path                                   | notes                                                |
|---------|----------------------------------------|------------------------------------------------------|
| GET     | `/account/:id/workspaces`              | Workspaces the account is a member of (re-add)       |
| GET     | `/workspace/:slug`                     | Workspace by slug (session must be a member)         |
| POST    | `/workspace`                           | Create. Body: `{ slug, name }`. Creator = owner.     |
| PATCH   | `/workspace/:slug`                     | Update name/slug/image. Owner or admin.              |
| DELETE  | `/workspace/:slug`                     | Soft delete, cascades. Owner only.                   |
| POST    | `/workspace/:slug/leave`               | Leave. Blocked if last owner.                        |
| POST    | `/workspace/:slug/transfer`            | `{ targetAccountId }`. Owner only.                   |
| GET     | `/workspace/:slug/members`             | List members + roles. Any member.                    |
| PATCH   | `/workspace/:slug/members/:accountId`  | Change role. Admin+; cannot demote self if last owner. |
| DELETE  | `/workspace/:slug/members/:accountId`  | Remove member. Admin+.                               |
| POST    | `/workspace/:slug/invitations`         | Create invite (any of 3 types). Admin+.              |
| GET     | `/workspace/:slug/invitations`         | List pending. Admin+.                                |
| DELETE  | `/workspace/:slug/invitations/:id`     | Revoke. Admin+.                                      |
| GET     | `/invitations/:token`                  | Preview (name, inviter). Public (tokenized).         |
| POST    | `/invitations/:token/accept`           | Accept with an account. Authed session.              |

## Frontend UX

### URL structure
- `/w/:slug` — workspace home (list of lists)
- `/w/:slug/settings` — name, slug, image
- `/w/:slug/members` — member list + invite UI
- `/w/:slug/l/:list_id` — a list within a workspace (future — for now, lists still live at `/list/:id` and carry `workspace_id` server-side)
- `/invites/:token` — accept flow

### Workspace switcher
- Header dropdown, shows all workspaces across all session accounts, **grouped by account**.
- Selecting a workspace:
  - Persists the choice in `localStorage` (`session.currentWorkspaceId`).
  - **Auto-resolves the active account** to the account whose membership grants access to that workspace. This solves the "multiple authed accounts on one list" TODO for the common case.
  - Navigates to `/w/:slug`.
- Persistence note: `currentWorkspaceId` stays client-local (localStorage); `currentAccountId` likewise — it's per-tab/per-auth (authenticating *is* selecting an account), so it must never be server-synced. Server-syncing the last-active workspace was considered and deferred — see ADR 0013.

### Personal workspace label
If `slot = 'personal_workspace' && name IS NULL`, render as "Your Space" (or similar) rather than blank.

## Architecture: Workspace-as-DjibbList (current direction)

> **Direction change from earlier in this doc's life.** An earlier
> revision argued *against* a `DjibbWorkspace` DO on the grounds that
> "membership is server-rule-y and rarely-read." That position has
> been superseded — by CONTEXT.md's "djibb uses itself" principle,
> by ADR 0008 (cascade delete via a per-DO alarm dispatcher), and
> by ADR 0009 (tokenless DO-resident invitations). All three want a
> Workspace DO. The sections below describe the target shape; the
> §Migration plan section describes how we get there from the current
> D1-rows-only world.

A Workspace is **a djibb entity, same DO substrate as a List or
Template.** `DjibbList` becomes the abstract base class (rename TBD —
`DjibbEntity` is the candidate); `DjibbList`, `DjibbTemplate`, and
`DjibbWorkspace` are the concrete subclasses. The top-level
`type` discriminator (`list | template | workspace`) on the entity
row names the variant. The base class owns: the mutation log, the
push/pull machinery, the alarm dispatcher (ADR 0007 + ADR 0008),
the keyspaces protocol (`workers/src/replicache/keyspaces.ts`),
the in-DO invitation flow (ADR 0009). Subclasses override: the
mutator registry, the keyspaces array, the entity-row schema
extension, and any subclass-specific alarm events.

**Membership lives in the workspace's own
`authorization_rules.authorized_accounts`** — the same shape Lists
already use. `AccountWorkspace` D1 rows become a *transitional
artifact* of the legacy model, retired once the migration completes.
The `account_authorizations` derived D1 index (ADR 0009) is the
cross-entity read path for "what workspaces am I a member of."

**Workspace invitations collapse onto ADR 0009's unified flow.**
The standalone `workspace_invitations` D1 table retires the same way
`AccountWorkspace` does, replaced by an in-DO invitation row on the
workspace DO that participates in the same role-gated pull keyspace
as List/Template invitations. The invitee flow shipped for entity
invites in May 2026 extends to workspaces with no new shape.

**Why this is worth the cost.** The doc previously framed Workspace
membership as "rarely-read" and therefore not worth Replicache. That
read pattern is real, but it ignored the *write* pattern: invitations,
role changes, member removals, ownership transfers, cascade deletes,
and "Start Fresh" are all writes that benefit from the same uniform
mutation pipeline that Lists use — optimistic update, offline queue,
mutation log entry, alarm-driven side effects. ADR 0003's core
argument ("the project's identity lives on the write side") applies
to Workspace at least as forcefully as to List.

## Sync model

- **DjibbWorkspace DO (Replicache, authoritative):** the workspace
  entity row, its members (`authorized_accounts`), its pending
  invitations, and any workspace-level body content (Island hex
  coords from ADR 0008's "Personal Workspace as Island," future
  dashboard-like surfaces). Members and invitations live in
  role-gated pull keyspaces; PII never leaks to non-admins
  (`docs/handoffs/2026-05-25-invitation-flow-corners-cut.md` §6
  applies the same way it does for Lists).
- **D1 derived indexes (read-fast-path):** `workspace_entities`
  carries the workspace's catalog row (name, slug, slot,
  cascade_source, time_deleted). `account_authorizations`
  (ADR 0009) carries `(account_id, entity_id, role)` for every
  membership across List/Template/Workspace, enabling the "my
  workspaces" and "shared with me" queries without instantiating
  every DO.
- **DjibbList / DjibbTemplate DOs:** unchanged. They carry
  `workspace_id` on the entity row; auth middleware resolves a
  workspace-grant for a list by consulting the workspace's
  derived index row (fast path) and falling back to the workspace
  DO when the rule needs to be authoritative.

The pull overlay direction set by ADR 0003 holds: the DO's row is
the answer; D1 is a denormalized cache the workers can read for
catalog views without paying a DO instantiation per row.

## Migration plan

The migration is a refactor of a small live surface, not a data
migration against a real userbase. Order of operations:

1. **Base-class extraction.** Rename `DjibbList` → `DjibbEntity` (or
   keep `DjibbList` and have `DjibbWorkspace` extend it directly; TBD
   when implementation starts). Pull mutator-registry plumbing,
   push/pull machinery, alarm dispatcher, keyspaces orchestration,
   in-DO invitation flow, and entity-row schema scaffolding up to the
   base. The existing Template variant (`type: 'template'`) is the
   first validation that the extraction is clean.
2. **`DjibbWorkspace` skeleton.** New concrete subclass; mutator
   registry includes `initWorkspace`, `renameWorkspace`,
   `setWorkspaceSlug`, `setWorkspaceImage`, plus the invitation
   mutators inherited from the base. Entity row carries
   `slot`, `slug`. The `members` keyspace (role-gated:
   admins+ see the full list; members see themselves only) is the
   workspace-specific keyspace.
3. **Role enum reconciliation.** ✅ Done (shipped across ADR 0011).
   The `admin`-vs-`owner` question is settled: distinct roles, `admin`
   unbounded co-admin, `owner` the single transferable principal
   (ADR 0011 §Decision C). Capability tiers
   (`EDIT_ROLES`/`OWNER_ROLES`/`SYSTEM_ROLES`) and the single-owner
   invariant (`assertSingleOwner`) are enforced per-mutator rather than
   through a monolithic choke-point. Corollary invariant: **ownership
   is transferred (`transferOwnership`), never invited** — the
   invitable role set (`InvitableRoleEnum`) excludes `owner`, so an
   admin cannot mint an owner via the invite path.
4. **Personal workspace on account creation.** Wire
   `account/service.ts::CreateAccount` to instantiate a
   `DjibbWorkspace` stub with `slot: 'personal_workspace'` and push the
   `initWorkspace` mutator. Closes the existing TODO.
5. **Auth resolver rewrite.** `auth/rules.ts`'s workspace-grant
   resolution stops reading `AccountWorkspace`; it reads the
   `account_authorizations` derived index. Reconciliation sweeper
   (ADR 0007) backstops drift.
6. **Membership migration.** Existing `AccountWorkspace` rows for
   any non-trivial workspaces get emitted into the corresponding
   workspace DO's `authorized_accounts` (one-shot script if
   needed). Personal workspaces are re-spawned on first hit if the
   pre-migration row didn't yet exist as a DO.
7. **List move + workspace_id auth path.** Lists carry
   `workspace_id` on the entity row; the workspace-grant fast path
   in list auth middleware reads `account_authorizations` for
   `(account_id, workspace_id)`.
8. **Cascade dispatcher (ADR 0008).** Lands once steps 1-2 are
   solid; the alarm dispatcher generalizes the existing ADR 0007
   reconciliation alarm to handle multiple per-DO scheduled events.
9. **Trash UI + Start Fresh** (ADR 0008 prerequisites for shipping
   `deleteWorkspace`).
10. **Workspace invitations onto ADR 0009.** ✅ Done (ADR 0011 §10d).
    `workspace_invitations` had already retired in §7b.3; since
    workspaces are DjibbLists, `inviteByIdentity` / `revokeInvitation` /
    `pending_invites` worked server-side unchanged. The remaining work
    was client + accept-path: the shared `EntityInvites` component on
    `/w/[slug]/members`, the `acceptUrl` slug fix, a pending-invite-gated
    slug→id resolver (`/workspace-invite/:slug`), and a `/w/[slug]`
    invitee branch rendering the `InviteBanner`.

Surface today is small enough that we may opt to wipe rather than
backfill — decide at apply time.

## Slicing

**Phase 1 — Foundation.**
- Base-class extraction (`DjibbList` → `DjibbEntity` + concrete
  subclasses). Templates validate the extraction is clean.
- `DjibbWorkspace` skeleton with `initWorkspace`, `renameWorkspace`.
- Personal workspace auto-created on account signup.
- Role enum reconciliation ADR + migration.

**Phase 2 — Membership + reads.**
- Membership moves to `authorized_accounts` on the workspace DO;
  `account_authorizations` derived index becomes the read path.
- Auth resolver rewrite for workspace-grant fast path.
- Frontend: workspace switcher, `/w/:slug` home,
  `/w/:slug/settings`, `/w/:slug/members` (read-only).
- `GET /account/:id/workspaces` re-added against the derived index.

**Phase 3 — Invitations (collapse onto ADR 0009).** ✅ Done (ADR 0011
§10d).
- `inviteByIdentity` mutator on the workspace DO (inherited — workspaces
  are DjibbLists, so it worked unchanged).
- Workspace invite UI reuses the entity-invite component
  (`EntityInvites` on `/w/[slug]/members`).
- Workspace accept-banner flow reuses `InviteBanner` via a `/w/[slug]`
  invitee branch, reachable pre-membership through a pending-invite-gated
  slug→id resolver.
- `workspace_invitations` table retired (in §7b.3).
- Link-type invitations: still a separate ADR slice (open question
  against ADR 0009).

**Phase 4 — Cascade + Trash (ADR 0008).**
- Alarm dispatcher generalization.
- `deleteWorkspace` / `restoreWorkspace` / `startFresh`.
- Trash UI surface (`time_deleted IS NOT NULL` per-account view).

**Phase 5 — Polish.**
- Transfer-ownership flow + email confirmation. ✅ Done — `transferOwnership`
  mutator (owner-gated, recipient-must-be-a-member guard, single-owner
  invariant) + new-owner notification and former-owner receipt emails
  fired from the DO post-commit tail.
- Move-list-between-workspaces UI. ✅ Done — `moveList` mutator
  (`requiredRole: OWNER_ROLES`, set-family inverse for undo) +
  `preflightMoveList` (actor-must-be-member-of-destination gate via D1,
  wired into `runMutationPreflight`) + workspace picker in `Share.svelte`.
- Permission-bag usage (custom perms).
- Keep the workspace switcher fresh while a tab is open. ✅ Done —
  `SessionState.revalidateWorkspaces()` re-runs the existing
  `GET /a/<id>/workspaces` fetch (the `entity_memberships` projection)
  and re-hydrates without disturbing the active selection; fired from
  `+layout.svelte` on window-focus + `visibilitychange`. No new DO, no
  CVR, no poke — those were considered and deferred (see ADR 0013).
  Optional follow-up: also call `revalidateWorkspaces()` after the
  actor's own membership-changing actions (create workspace / accept
  invite / leave) for instant in-tab refresh. Instant *cross-account*
  push (an invite appearing without a refocus) stays deferred to the
  notification feature that justifies an account-level channel.

## Open questions / TODO (not blocking v1)

- **Role enum reconciliation.** ✅ Resolved (shipped across ADR 0011) —
  `admin` and `owner` are distinct, capability tiers replace a
  per-mutator permission bag, and the single-owner invariant is
  enforced per write-site via `assertSingleOwner`. Ownership is
  transferred, never invited (`InvitableRoleEnum` excludes `owner`).
  (The richer permission-bag/custom-perms idea is tracked separately
  under Phase 5 polish.)
- **Link-type invitations.** ADR 0009 covers `email` + `username`.
  Adding `link` (multi-use, public-URL) is open against that ADR —
  not blocked on Workspace-as-DjibbList specifically.
- **Slug reserved words** (`settings`, `members`, `invitations`,
  `api`, `admin`, etc.). Already partially enforced in
  `workspace/service.ts::RESERVED_SLUGS`.
- **Min/max member count per workspace** (billing implications later).
- **Workspace-level audit log.** Becomes mostly free once
  invitations + cascade events are in the mutation log; surfacing
  a UI for it is separate.
- **Auth-by-workspace flow** (Slack-style `workspace.djibb.app`) —
  `auth/README.md` flags this as unclear.
- **Image upload** (currently `workspaces.image` is a URL — no
  upload path).
- **Email-sending integration.** Cloudflare's Email Service beta
  is the candidate stack:
  https://developers.cloudflare.com/email-service/llms.txt
