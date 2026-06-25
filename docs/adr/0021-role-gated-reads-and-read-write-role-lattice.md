# ADR 0021: Role-gated reads (view-floor) and the read/write role lattice

- **Status:** Accepted; not yet implemented. Supersedes the de-facto
  capability-URL read behavior of `handlePull`. Amends ADR 0011 (the
  `AuthorizationRoleEnum` "not widened" note and Decision C's capability-layer
  deferral).
- **Date:** 2026-06-18
- **Layer:** protocol

## Context

CONTEXT.md has always promised that **visibility = `AuthorizationRules.default_role`**
— a "private" entity is one with `default_role: 'restricted'`. The code never
delivered it. `handlePull` (`packages/server-cf/src/list/durable_object.ts`)
returns the **full element tree to any resolved role**; `resolveSessionRole`
(`fetch.ts`) never rejects; the only role-filtered keyspaces are
`pending_invites/*` (ADR 0009). So in practice the read model was an *unintended*
capability-URL one: knowing an entity's id was equivalent to read permission,
and `restricted` did not actually restrict reads.

That was never a decision — just unimplemented work at ~60%-to-MVP. Two forces
made it a decision that has to be made now:

1. **It is a genuine hole.** Reads aren't revocable: a collaborator you remove
   (demoted to `restricted`) keeps reading content forever. Workspace-routed
   entities are addressed by a human-guessable slug, so even the obscurity
   "protection" is weak.
2. **Where the protocol is going requires it.** djibb is a substrate for "weird
   clients" (Secret Santa first: append a wish, mark "purchased," **hide
   purchases from the recipient**). Hiding a subset of state from the very
   principal you shared an entity with is structurally impossible under a
   capability-URL model. Read authorization has to become first-class.

The deeper question this surfaced — **roles or a capability layer?** — was
re-litigated against ADR 0011 Decision C ("the role IS the capability tier; one
mechanism, not two," capability layer deferred). It still holds, for a reason
0011 only implied: **entity-decomposition turns composition-of-permissions into
composition-of-entities.** A principal who needs "append AND check but not edit"
is modeled as two entities (one they `submit` to, one they `check`), each with
one clean role — which the substrate does natively ("lists all the way down").
Secret Santa needs **zero** new protocol code: "mark purchased" is
`setItemQuantity` on a separate purchase-status entity; "hide from recipient" is
the recipient holding `restricted` on that entity. So capabilities stay deferred,
and the role enum grows a new bundle only when a genuinely orthogonal capability
appears.

## Decision

1. **Reads are gated at a view-floor.** Define `VIEW_ROLES` = `owner | admin |
   editor | checker | viewer | ownerless`. `handlePull` emits content only to
   roles in `VIEW_ROLES`; `restricted` and `submitter` are below the floor and
   receive **no content**. A sub-floor pull **succeeds with an empty content
   patch** (never 403) so Replicache does not retry-storm.

2. **Roles are capability bundles across two independent axes — read and write
   — not a single power ladder.** The canonical placement:

   | Role | Read content | Write |
   |---|---|---|
   | `owner` / `admin` | yes | full (admin = all but destroy/transfer) |
   | `editor` | yes | full structural edits |
   | `checker` | yes | check-off only (`setItemQuantity`) |
   | `submitter` | **no** | append only (`createListItem`) |
   | `viewer` | yes | none |
   | `restricted` | no | none |
   | `ownerless` | yes | full (URL-collaborative) |

   `viewer` (read-without-write) and `submitter` (write-without-read / blind
   append) are duals. `submitter` is **new** in this ADR; `APPEND_ROLES`
   (`EDIT_ROLES` + `submitter`) gates `createListItem`, and every structural /
   destructive mutator keeps gating on `EDIT_ROLES` (which excludes `submitter`),
   so `default_role: 'submitter'` is append-only by construction. This is what
   makes a holding-pen / suggestion-box / Secret-Santa drop private *from its own
   contributors* without leaning on an unguessable id.

3. **Capabilities stay deferred; weird clients use entity-decomposition + role
   assignment.** Reaffirms ADR 0011 Decision C. The per-mutator/field capability
   layer is not built. The escape hatch for a client that needs genuinely new
   server behavior is its own mutators (registry) / its own backend deployment —
   not bespoke logic in core auth.

4. **Invitee preview = accept-to-view.** A pending invitee is not yet in
   `authorized_accounts`, so they resolve via the default path to the entity's
   `default_role`: a `viewer`+ (public) entity previews normally; a `restricted`
   (private) entity stays dark until accept. The invite **banner renders from the
   invitation record** (which names the entity), not from entity content, so no
   content leaks to a `restricted` invitee. Accept upgrades the role and the
   existing ADR-0009 promotion/full-sync path delivers content. No dedicated
   preview tier.

## Consequences

- `handlePull` gains a `VIEW_ROLES` gate that filters **content** keyspaces (the
  element tree), returning an empty-not-403 patch below the floor. The
  `pending_invites/*` filter (ADR 0009) is unchanged.
- ADR 0009's promotion / demotion-eviction orchestration must extend from
  `pending_invites/*` to **content** keyspaces: on a role gaining read access,
  full-sync from version 0; on a role losing it (revocation/demotion), emit `del`
  for the content keys the prior role could see. This is what finally makes reads
  **revocable**.
- `checker` becomes load-bearing (it is currently latent — in `EDIT_ROLES`, so
  indistinguishable from `editor`). Enforcing check-off-only is a **narrowing**
  refactor (remove `checker` from `EDIT_ROLES`, re-add it only to
  `setItemQuantity` and any future "purchased" mutator) and is **deferred to the
  Secret Santa build**, with no consumer yet to validate it. `submitter` ships
  first because it is purely **additive** (no existing role set changes).
- The read view-floor is a security workstream separable from any single feature
  (e.g. GH #9's Contributed List goes fully-private the moment it lands, but does
  not block on it).

## Considered and rejected

- **Ratify capability-URL reads** (id-possession = read). Rejected: no read
  revocation, weak for slug-addressed entities, and structurally cannot hide a
  subset of state from a principal you shared the entity with — which the
  substrate's target clients require.
- **Per-mutator / per-field capability layer** (ADR 0011 Decision C's deferred
  option). Still deferred: entity-decomposition + a small role lattice covers the
  foreseeable weird-client space with one mechanism instead of two. Revisit only
  when a concrete permission shape cannot be modeled as "more entities, each with
  one role."
- **Field-level ACLs** for the Secret Santa "purchased" hiding. Rejected in favor
  of decomposition (purchase-state as its own entity), which reuses the same
  role + view-floor mechanism and keeps CONTEXT.md's "no separate visibility
  field" invariant.
