# ADR 0011: `DjibbList` as universal entity substrate; unified role enum

- **Status:** Accepted; implemented (core implementation order steps 1–10
  complete — see §Implementation order; Phase 5 polish ongoing per
  `docs/workspaces.md`, move-list shipped)
- **Date:** 2026-05-25
- **Layer:** protocol

## Context

Three things landed together that forced a re-examination of how
djibb represents its entity-shaped concepts (List, Template,
Workspace, and the next several things that will look like one of
these):

1. **Workspace-as-DO direction is current.** CONTEXT.md, ADR 0008
   (cascade delete), and ADR 0009 (tokenless DO-resident
   invitations) all assume Workspace is a DO-backed entity sharing
   substrate with List and Template. The older `docs/workspaces.md`
   §"why no `DjibbWorkspace` DO" was reconciled out in commit
   `cf6a1e9`. With that direction settled, the next question is
   *how* the substrate is shared: subclass tree, type discriminator,
   or something else.
2. **Notifications need a home.** Designing the inbox as a hidden
   List inside the account's personal Workspace surfaced a *family*
   of "well-known entity roles" — personal workspace, inbox, Seed
   Pool, future Trash view / Templates library / "shared with me" —
   that all want consistent hiding, lookup, and lifecycle rules.
   Each new one accumulating its own boolean column on the entity
   row (`is_personal`, `system`, …) is the wrong shape.
3. **`WorkspaceRoleEnum` and `AuthorizationRoleEnum` diverged on the
   surface but already agreed underneath.** The legacy workspace doc
   named four roles (`owner | admin | member | viewer`); entities
   use a wider set (`owner | admin | checker | editor | viewer |
   ownerless | restricted`) — `admin` is already there, and was
   added precisely as the "non-principal owner" tier. The two enums
   need to merge, not be invented from scratch. Membership-as-an-
   `authorized_accounts`-entry (CONTEXT.md, ADR 0009) collides with
   any divergence immediately — workspace membership can't carry a
   role the entity layer doesn't know about.

Treated as three problems, each gets its own design. Treated as
one, they collapse into a single decision: **what's the shape of
the unified entity substrate, and what's its role vocabulary?**

## Decision

### A. One class, type-discriminated; no subclass tree

`DjibbList` continues to be the only concrete Durable Object class
for entities. List, Template, and Workspace are all instances of
this class, distinguished by a `type` discriminator on the entity
row (`type: 'list' | 'template' | 'workspace'`). Templates already
prove this pattern works — they share `DjibbList`'s storage,
mutators, pull/push, and alarm dispatcher with Lists today.
Workspace becomes a third value in the discriminator with no
structural divergence beyond:

- Different mutator set (registered alongside the existing
  mutators; the dispatcher routes by name and gates by
  `requiredRole` + arg validation).
- Different keyspaces (`members` for Workspace; `items` / `groups`
  for List).
- Different body shape — Workspace's body is near-empty (no items
  or groups; Island hex coords are a separate concern).
- Different alarm-dispatcher events (cascade-archive / cascade-
  restore from ADR 0008 are Workspace-only events on the shared
  dispatcher).

**`DjibbList` is kept as the class name despite the misnomer.**
A rename to `DjibbEntity` would more accurately describe what the
class actually is, but the cost (every import, every test, every
binding name, every grep) outweighs the clarity win at this stage.
The name is treated as a historical artifact, similar to how Unix
calls a process's address-space-and-thread bundle a "process."
Reconsider if the misnomer ever causes a real misunderstanding.

### B. `slot` column replaces `is_personal` and any future booleans

Every entity row carries a single nullable `slot` column — a
string discriminator naming the well-known role the entity fills.
Validated by a Zod enum:

```ts
SlotEnum = z.enum([
    'personal_workspace',  // type: 'workspace', exactly one per account
    'inbox',               // type: 'list', exactly one per account
    'seed_pool',           // type: 'list', exactly one globally
    // future: 'trash_view', 'templates_library', 'shared_with_me', ...
]).nullable();
```

`slot IS NULL` is the default (ordinary user-created entity). The
column applies uniformly across every `type`.

**`slot` is purpose, not control.** It describes what the entity is
*for*, not who manages it. A user could in principle create their
own "secondary inbox" — same purpose, same hidden semantics, but
mutated by them — and it would still carry `slot: 'inbox'`. Who
can mutate the entity is determined by
`authorization_rules.authorized_accounts`, exactly as for any
other entity.

**Per-account-slot lookup pattern:** the account row gets a
pointer column per slot it cares about (`personal_workspace_id`,
`inbox_entity_id`). The pointer is the fast path; `slot` is the
integrity guard ("the workspace this account points at really does
claim to be its personal one"). For global slots (Seed Pool), a
small `system_entities` D1 table keyed on `slot` plays the same
role.

**UI catalog-hiding** is a single predicate everywhere: `slot IS
NULL`. Lifecycle rules ("cannot delete the personal workspace,"
"Start Fresh re-spawns the inbox") live in a slot-keyed dispatch
table consulted by the relevant mutators, not as `if (is_personal
&& ...)` checks sprawling across the codebase.

### C. Workspace membership adopts `AuthorizationRoleEnum`; `owner` is the unique principal

`WorkspaceRoleEnum` retires. Workspace membership uses the existing
`AuthorizationRoleEnum`, which already carries the tiers we need —
`admin` is already there as the "owner-tier delegate" role and was
added precisely for this purpose. The mapping:

- workspace `owner`  → entity `owner` (unique principal; see below)
- workspace `admin`  → entity `admin`
- workspace `member` → entity `editor`
- workspace `viewer` → entity `viewer`
- (no workspace tier maps to `checker`, `ownerless`, or
  `restricted`; those are entity-specific states — restricted is
  the pre-accept invitation state, ownerless is a bootstrap
  artifact, checker is for delegated checkbox-only access on
  Lists.)

**The `owner` slot is unique per entity.** Exactly one account
per entity holds `role: 'owner'` at any time — the principal. The
principal is the only account allowed to fire destructive ops on
the entity itself: `deleteEntity` / `deleteWorkspace`,
`transferOwnership`, `setListAuthRules` (for changes that affect
their own role), and any future ops with cascade-tier
consequences. Today's `requiredRole: 'owner'` mutator gate
already enforces this — no new mechanism needed.

**`admin` is the multi-allowed owner-tier delegate.** Admins can
invite, remove members (except the principal), rename, change
slug/image, archive non-cascade items, and otherwise do everything
an owner can do *short of* the destruction-tier ops gated by
`requiredRole: 'owner'`. Multiple admins per entity are
unrestricted.

**Transfer ownership = atomic role swap.** `transferOwnership`
takes a target `account_id` already in `authorized_accounts`,
verifies the actor is the current `owner`, and atomically:
demotes the actor from `owner` to `admin`, promotes the target to
`owner`. Single-owner invariant preserved across the boundary.
The default-demote-to-`admin` is configurable in the mutator
(future: option to leave the previous owner; v1 demotes).

**Why this shape over the alternatives:** `admin` was added to
`AuthorizationRoleEnum` for exactly this reason in an earlier
iteration. The legacy `WorkspaceRoleEnum` was the divergent enum;
the entity-level enum already had the right structure. Inventing
a parallel per-mutator capability layer (a `created_by_account_id`
column + `requiresPrincipal` flag) was considered and rejected
because it re-encodes the role tier sideways — the role IS the
capability tier, and `owner`-being-unique IS the principal
constraint. One mechanism, not two.

**`AuthorizationRoleEnum` is not widened by this ADR.** The enum's
current value set is sufficient. Existing role predicates on Lists
and Templates do not change — they continue to gate on
`owner`/`editor`/`viewer` exactly as today. The `admin` tier was
already in the enum; this ADR commits to it as the canonical
non-principal owner-tier slot.

> **Amended 2026-06-18 (ADR 0021).** Scope of "not widened" was the
> workspace→entity role mapping above. The enum *does* widen when a
> genuinely **orthogonal write-capability** (a strict subset of `editor`)
> appears: `submitter` (write-without-read / append-only) was added, and
> `checker` (latent here as "checkbox-only access") is to be enforced for
> the Secret Santa client. The role set is thus a small **lattice of
> capability bundles across read/write axes**, not a linear tier ladder.
> One mechanism still (Decision C holds) — see below.

## Pros and cons against alternatives

### What "extract `DjibbEntity` base class, subclass per type" would have won

- **Honest naming.** Class names match what they represent. No
  Workspace-pretending-to-be-a-List on import lines.
- **Stricter type narrowing.** A `DjibbWorkspace`-typed method can
  refuse to take List-shaped args at compile time; a discriminated
  class has to runtime-check the `type` field.
- **Clear extension point.** Adding a fourth entity kind in the
  future would mean writing a new subclass, not stuffing more
  branches into the existing class.

Rejected because: the divergence between the variants is too small
to justify the inheritance machinery. The list of things that
*actually* differ between List and Workspace (mutator set,
keyspaces, body schema, a handful of alarm events) is shorter
than the list of things that are identical (push/pull, mutation
log, alarm dispatcher, role gating, invitation flow, replication,
catalog emit, soft-delete). Templates already validate that one
class can carry multiple `type` values cleanly; promoting the
existing pattern to three variants stays within the same shape.

The naming cost is real but bounded; the inheritance refactor
cost is unbounded and would block actual product work for weeks.

### What a sprawl of booleans (`is_personal`, `system`, `is_seed_pool`, ...) would have won

- **Trivial schema migration.** Each boolean is a single ALTER
  TABLE ADD COLUMN. No enum to validate, no cross-cutting
  predicate to think through.
- **Bitwise composability.** An entity could in principle be both
  `is_personal` and `is_seed_pool` if some future weird case
  demanded it. A single `slot` column is mutually exclusive by
  construction.

Rejected because the booleans accumulate forever and each one is
a new branch in every place that needs to special-case
"well-known entities." The mutual exclusion the `slot` enum
enforces is a *feature* — there is no coherent meaning for "the
inbox that is also the personal workspace," and the schema should
reflect that.

### What a per-mutator capability layer would have won (vs `admin` role + unique-`owner`)

- **Capability is orthogonal to role.** Future ops that don't fit
  cleanly into the tier ladder (e.g. "this account can fork as
  template" but not "this account can edit the entity") have a
  natural home as a capability string, not by inventing a new
  role tier per capability.
- **Multiple principals possible.** A `requiresPrincipal` check
  derived from a `created_by_account_id` column allows the principal
  to be one of several, with capability bits per principal — Slack-
  style "all owners can delete the workspace."

Rejected because it reinvents the role tier sideways. `admin`
was added to `AuthorizationRoleEnum` precisely as the "owner-tier
delegate" role; using that tier plus a unique-`owner` invariant
expresses the same semantics with one mechanism instead of two.
The Slack-style multi-principal need is real but rare for v1;
when it surfaces, the unique-`owner` constraint can be relaxed
(promote `owner` to a multi-account slot, or graft a capability
layer on top) without losing data — the per-mutator-capability
shape is not foreclosed, just deferred until a concrete need
justifies it.

> **Reaffirmed 2026-06-18 (ADR 0021).** Re-litigated against the
> "weird client" ambition (Secret Santa: append-only, check-off-only,
> hide-purchases-from-recipient). Decision C still holds — capabilities
> stay deferred — for a reason only implied here: **entity-decomposition
> turns composition-of-permissions into composition-of-entities.** A
> principal needing "append AND check but not edit" is two entities (one
> `submit`-only, one `check`-only), each with one role, which the
> substrate does natively. Secret Santa needs zero new protocol code.
> The capability layer is revisited only when a permission shape cannot
> be modeled as "more entities, each with one role."

### What keeping `WorkspaceRoleEnum` and translating at the boundary would have won

- **Workspace-domain code keeps its native vocabulary.** Service-
  layer code that reasons about admins doesn't have to translate
  to `editor` and back.
- **Future divergence stays cheap.** If Workspace later wants a
  fifth role (`guest`?), it doesn't drag List and Template along.

Rejected because the substrate framing is the whole point of this
ADR. Membership-as-an-`authorized_accounts`-entry doesn't work if
the role on that entry is in a different enum than the one
`authorized_accounts` validates against. Translation at every
read/write would re-introduce exactly the two-store-coordination
friction ADR 0003 spent its budget eliminating.

## Consequences

**Positive:**

- One substrate for every entity-shaped concept. New entity kinds
  (notifications inbox, Trash view, Templates library, agent
  scratch spaces, "shared with me" indexes) cost a new `type`
  value + a mutator set + a `slot` value, not new DO machinery.
- Realtime sync, offline edit queue, mutation log, role-gated
  pulls, in-DO invitations, and the alarm dispatcher are available
  to every new entity kind by default. The "build it as a List"
  reflex becomes correct most of the time.
- The single role vocabulary across List/Template/Workspace
  unblocks ADR 0009's `account_authorizations` derived index as a
  uniform shape — one row per `(account_id, entity_id, role)`
  across every entity kind, no per-kind enum.
- No new capability machinery to design or test — the existing
  `requiredRole` field plus the `owner`-is-unique invariant carry
  the full semantics that took the legacy 4-tier
  `WorkspaceRoleEnum` to express.
- `slot` as a cross-cutting primitive cleans up several
  ad-hoc lookup patterns at once (the Seed Pool's find-by-magic-ID,
  the personal workspace's `is_personal` boolean, the future
  inbox's hiding rule).

**Negative:**

- `DjibbList` is misnamed for two of its three uses. Reading the
  code, you have to know "List here means entity." Onboarding
  cost.
- `type` discriminator branching inside the class accumulates as
  variants diverge. We've committed to keeping the divergences
  small, but Postel's law applies: code that started as a clean
  switch will grow if-laden over time. Periodic refactoring to
  pull variant-specific code into helpers is on us.
- Single-owner invariant has to be enforced at every write site
  that can set `role: 'owner'` on an `authorized_accounts` entry
  — the `initList`/`initWorkspace` path, `acceptInvitation` when
  the invited role is `owner`, `transferOwnership`, and any
  future op that grants membership. Wrong place to leak this
  invariant; needs a shared helper.
- Migrating existing `WorkspaceRoleEnum` usages — including the
  `workspace/service.ts` HTTP path that's already live — to the
  collapsed enum is a real chunk of code change, including any
  serialized session/state that carries a workspace role.
- The `is_personal` column (proposed but not yet in the schema)
  is replaced before it lands. `docs/workspaces.md` was updated
  in commit `cf6a1e9`; any in-flight code referring to
  `is_personal` needs to switch to `slot`.

## Implementation order

This ADR is design-only. Implementation sequencing (numbered
against `docs/workspaces.md` §Migration plan):

1. **`slot` column + `SlotEnum`** on the entity row (DO sql +
   `workspace_entities` D1 catalog). Migration. Zod schema in
   `workers/src/list/index.ts`. No-op for existing entities
   (`slot: null`).
2. **Add `'workspace'` to the `type` discriminator** in
   `workers/src/list/index.ts::ListElementUnion` (or wherever
   `type` is defined). Plumb through schemas, route handlers,
   pull keyspaces.
3. **Single-`owner` invariant + transferOwnership mutator.** Add
   the unique-`owner`-per-entity check as a shared helper used by
   every site that writes an `authorized_accounts` entry with
   `role: 'owner'`. Add `transferOwnership` mutator that
   atomically demotes the current owner to `admin` and promotes
   the target to `owner`. Existing entities (which already have
   exactly one `owner`) satisfy the invariant by construction.
4. **Retire `WorkspaceRoleEnum`.** Migrate `workers/src/workspace/index.ts::WorkspaceRoleEnum`
   usages and any persisted workspace-role values to
   `AuthorizationRoleEnum`. Mapping per Decision C. Workspace
   destructive ops (`deleteWorkspace`, `transferOwnership`,
   `startFresh`) gate on `requiredRole: 'owner'` — no new
   machinery.
5. **`createWorkspace` / `renameWorkspace` / `setWorkspaceSlug`
   / `setWorkspaceImage`** mutators on the existing mutator
   registry. Workspace push/pull works.
6. **Personal-workspace-on-account-signup.** Closes the
   `account/service.ts::CreateAccount` TODO. Sets
   `slot: 'personal_workspace'` on the new workspace DO; writes
   `accounts.personal_workspace_id` pointer.
7. **Membership migration.** `AccountWorkspace` D1 rows emit into
   the workspace DO's `authorized_accounts`. `account_authorizations`
   derived index (ADR 0009) becomes the read path.
8. **Auth resolver rewrite.** `auth/rules.ts`'s workspace-grant
   resolution reads the entity-membership projection, not
   `AccountWorkspace`. *(Shipped implicitly with §7b.2 — the projection
   landed as `entity_memberships` rather than the originally-planned
   `account_authorizations` name, and `GetMembership` was ported in
   the same commit, so `auth/resolver.ts` switched data sources without
   needing a follow-up. Audit confirmed in §7b.6 close-out.)*
9. **Frontend.** Workspace switcher, `/w/:slug` home, settings,
   members. *(Switcher / settings / members shipped in §7b.x; the
   `/w/:slug` home is the workspace's Island view per ADR 0002 — a
   multi-slice effort tracked separately, not closed by this ADR.
   The page currently surfaces the role indicator with a forwarding
   pointer to ADR 0002 so the surrounding chrome is usable without
   implying a list-of-lists picker, which ADR 0002 explicitly
   rejects as the primary view.)*
10. Cascade dispatcher (ADR 0008), Trash UI, "Start Fresh,"
    invitations collapse onto ADR 0009 — all gated on steps 1–6
    landing first. *(Shipped: §10a cascade dispatcher, §10b Trash UI +
    per-DO hard-delete clock, §10c personal-workspace "Start Fresh,"
    §10d workspace invitations onto ADR 0009. The invitation work split
    into §10d.1 invite UI — the shared `EntityInvites` component on the
    members page, since workspaces are DjibbLists the `inviteByIdentity`
    / `revokeInvitation` / `pending_invites` machinery already worked
    server-side; §10d.2 the `acceptUrl` slug fix in `fireInvitationEmails`;
    §10d.3 the pre-membership accept surface — a pending-invite-gated
    slug→id resolver (`/workspace-invite/:slug`) plus a `/w/[slug]`
    invitee branch that mounts Replicache by id and renders the
    `InviteBanner`. With this, the implementation order is complete.)*

Steps 3 (single-owner invariant) and 4 (enum retirement) can land
together since they're paired by design.

## Open questions

- **Single-`owner` invariant enforcement site.** The check has to
  live in a shared helper because at least four mutators can set
  `role: 'owner'` (`initList`/`initWorkspace`, `acceptInvitation`,
  `transferOwnership`, `setListAuthRules`). Likely shape: a
  `mutateAuthorizedAccounts(...)` helper in `workers/src/list/mutators/_shared.ts`
  that every site routes through, with the invariant assertion
  baked in. Settle when step 3 begins.

- **Audit / lineage `created_by_account_id` column.** Not needed
  for capability gating (Decision C above), but possibly wanted
  independently for ADR 0008's `cascade_source` adjacency,
  Templates' `forked_from_id` lineage chain, or future "who
  created this" UI surfaces. Defer until a concrete need
  surfaces.

- **`type === 'workspace'` body content shape.** Empty for now;
  CONTEXT.md mentions Island hex coords as workspace-level body
  content. Defer until the Island layout work begins; the column
  could live on `workspace_entities` rather than on workspace DO
  body sql.

- **Migration of in-flight `is_personal` references.** Almost no
  production code refers to `is_personal` yet (the column isn't
  on the schema; only `docs/workspaces.md` mentioned it).
  `workers/src/workspace/index.ts::WorkspaceSchema` and
  `service.ts` may have inline references — verify and adjust as
  part of step 1.

- **Slot uniqueness enforcement.** "Exactly one
  `personal_workspace` per account" needs an invariant check
  somewhere. Probably:
  - At write time on the `initWorkspace` mutator, gated by a
    system-only invocation path (only fired by `CreateAccount`;
    not reachable from a client push). The synthetic-clientID
    pattern from ADR 0008 is the natural mechanism.
  - As a `UNIQUE(slot, owner_account_id) WHERE slot IS NOT NULL`
    partial index on `workspace_entities` (if SQLite supports it
    cleanly — D1 inherits SQLite semantics).

## References

- ADR 0003 — DO as authority with D1 derived index. The substrate
  here is an instance of that pattern.
- ADR 0008 — Cascade delete via Workspace-DO alarm dispatcher.
  Assumes the Workspace-as-DjibbList shape this ADR codifies.
- ADR 0009 — Tokenless DO-resident invitations. Same — the
  `account_authorizations` derived index is the cross-substrate
  read path.
- ADR 0010 — Magic-link authentication. Account creation flow
  triggers the personal-workspace auto-create in step 6.
- `CONTEXT.md` — "djibb uses itself" design principle, Workspace
  definition, Slot framing (entity-row column).
- `docs/workspaces.md` — Workspace-specific implications of this
  ADR, including the §Slots section and the §Migration plan that
  step-numbers map to.
- `workers/src/list/durable_object.ts` — the class this ADR keeps
  as the universal substrate.
- `workers/src/auth/rules.ts` — the `AuthorizationRoleEnum` that
  the role collapse adopts as canonical.
