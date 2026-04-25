# Workspaces

Design doc for the Workspaces feature. Captures ground-truth decisions so we don't re-litigate them while building. Updated as decisions change.

## What a workspace is

A **workspace** organizes accounts into a shared space so they can collaborate on lists. Think Slack workspace or Google Drive shared folder. Every account has exactly one **personal workspace** (Slack's DM-to-self equivalent) plus zero or more **shared workspaces**.

- A user has one or more **accounts** (OAuth identities); a single session can have multiple authed accounts.
- Each account is a member of its personal workspace and any shared workspaces it's been added to.
- Access to a workspace gives scoped access to every list the workspace contains.

## Data model

### `workspaces` (D1)

Extend the existing table. Changes vs. current `0001_create_user_and_session_tables.sql`:

| column         | type / notes                                                             |
|----------------|--------------------------------------------------------------------------|
| id             | TEXT PK, prefixed nanoid (`w/...`, 22 chars)                             |
| slug           | TEXT NOT NULL UNIQUE — **new**, URL-safe `[a-z0-9-]{3,40}`, lowercase    |
| name           | TEXT NULL — **changed**: no longer UNIQUE, now nullable, free-text (emoji OK — SQLite TEXT is UTF-8) |
| is_personal    | INTEGER NOT NULL DEFAULT 0 — **new**, 1 for the owner's personal workspace |
| flags          | TEXT NULL, JSON bag                                                      |
| image          | TEXT NULL                                                                |
| time_created   | INTEGER NOT NULL                                                         |
| time_updated   | INTEGER NOT NULL                                                         |
| time_deleted   | INTEGER NULL (soft delete)                                               |

**`slug` is the URL segment.** URLs use `/w/:slug/...`. Renames are allowed; no redirect table in v1 (old URLs 404, UI warns).

**`name` is the display name.** Free text including emoji. Personal workspaces default to `"<account.display_name>'s space"` if `display_name` exists, otherwise NULL. When NULL + `is_personal=1`, the frontend picks a label ("Your Space", "Scratchpad", etc.).

**`is_personal=1` invariants** (enforced in service layer, not SQL): exactly one owner, never more than one member, cannot be shared, cannot be deleted, cannot receive invites.

### `AccountWorkspace` (D1)

Existing table. One row per membership.

| column        | type / notes                                         |
|---------------|------------------------------------------------------|
| account_id    | TEXT NOT NULL → accounts(id)                         |
| workspace_id  | TEXT NOT NULL → workspaces(id)                       |
| role          | TEXT NOT NULL — `owner` \| `admin` \| `member` \| `viewer` |
| permissions   | TEXT NULL, JSON array of Clerk-style permission strings — reserved for future |
| time_joined   | INTEGER NOT NULL — **new**                           |
| PK            | (account_id, workspace_id)                           |

### `workspace_invitations` (D1, new)

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

Workspace roles (narrower than `AccountRoleEnum`; ontologically related but distinct):

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

- `is_personal=1`, single owner = the account.
- `name`: `"<display_name>'s space"` if `display_name` exists, else NULL.
- `slug`: generated from `user_name` if present, else from a random suffix (`personal-<8char>`). Uniqueness checked + retry on collision.
- Cannot be deleted, cannot be renamed into a non-personal workspace, cannot receive invitations, cannot have additional members added.
- Lists live there by default until the user moves them to a shared workspace.

## Lifecycle operations

### Create workspace
- Requires authed session. Creator's active account becomes the sole owner.
- Request body supplies `name`, `slug`. Server validates slug format + uniqueness.
- Creator is inserted into `AccountWorkspace` as `owner` in the same D1 batch.

### Update workspace (name, slug, image)
- Owner or admin.
- Slug rename allowed; no redirect table; UI warns.
- Personal workspaces: slug/name editable by the owner; `is_personal` is immutable.

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
- Persistence note: `currentWorkspaceId` (and eventually `currentAccountId`) will likely migrate to a Replicache Client View Record in the future — design with that in mind.

### Personal workspace label
If `is_personal=1 && name IS NULL`, render as "Your Space" (or similar) rather than blank.

## Architecture: why no `DjibbWorkspace` DO

Workspace membership, invitations, and roles are **server-rule-y and rarely-read**. Making them offline-capable via Replicache gains us nothing because the rules are authoritative on the server and change infrequently. Plain HTTP + D1 wins on simplicity.

Lists stay in `DjibbList` DOs with Replicache sync. The `workspace_id` on each list is a pure D1 pointer that the list's auth middleware consults.

**Action:** delete `workers/src/workspace/durable_object.ts` stub, remove the commented `DJIBB_WORKSPACE` binding from `workers/src/index.ts` and `workers/wrangler.toml`, drop `DjibbWorkspace` from Replicache client group assumptions.

If we later want a "workspace dashboard list" (shared scratchpad, channel-of-lists), it would be a normal `DjibbList` whose children are other lists. Not v1.

## Sync model

- **D1 (HTTP, authoritative):** workspaces, `AccountWorkspace`, `workspace_invitations`.
- **DjibbList DO (Replicache):** lists and their items. Auth middleware reads D1 workspace membership on each push/pull to resolve access.
- **No workspace data in Replicache.** Frontend fetches workspace/member lists via HTTP on page load and after mutations.

## Migration plan

New D1 migration `0002_workspaces.sql`:

1. Add `slug TEXT` and `is_personal INTEGER DEFAULT 0` to `workspaces`.
2. Drop the existing `UNIQUE(name)` on `workspaces` (SQLite requires table rebuild — do it).
3. Add `UNIQUE(slug)` on `workspaces`.
4. Add `time_joined INTEGER` to `AccountWorkspace`.
5. Create `workspace_invitations` table.
6. Data backfill: for each existing account without a personal workspace, create one and move its NULL-workspace_id lists into it. (If testing data is low, we may opt to wipe instead — decide at apply time.)

## Slicing

**Phase 1 (this v1):**
- DB migration
- Personal workspace on account signup
- Workspace CRUD endpoints (create/read/update/delete + leave)
- Member role resolution in list auth middleware
- Frontend: workspace switcher, `/w/:slug` home, `/w/:slug/settings`, `/w/:slug/members` (read-only member list)
- Re-add `GET /account/:id/workspaces`, root nav link, `/workspace` route registration
- Delete the `DjibbWorkspace` DO stub + binding

**Phase 2: Invitations**
- `workspace_invitations` create/list/revoke
- Email invitations first (requires email sender — scope TBD)
  - Please check out Cloudflare's beta email sending as part of their expanded Email Service product https://developers.cloudflare.com/email-service/llms.txt
- Username + link invitations
- `/invites/:token` accept flow
- Member role change + remove endpoints

**Phase 3: Polish**
- Transfer-ownership UI
- Move list between workspaces UI
- Permission-bag usage (custom perms)
- CVR-backed current_workspace_id / current_account_id
- Email-based transfer confirmation

## Open questions / TODO (not blocking v1)

- Slug reserved words (`settings`, `members`, `invitations`, `api`, `admin`, etc.).
- Min/max member count per workspace (billing implications later).
- Workspace-level audit log.
- Auth-by-workspace flow (Slack-style `workspace.djibb.app`) — `auth/README.md` flags this as unclear.
- Image upload (currently `workspaces.image` is a URL — no upload path).
