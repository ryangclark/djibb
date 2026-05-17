# ADR 0009: Invitations — tokenless, DO-resident, pull-filtered

- **Status:** Accepted (design only — implementation depends on Workspace-as-DO and magic-link auth landing)
- **Date:** 2026-05-17

## Context

djibb today has exactly one invitation mechanism: `workspace_invitations`
in D1, supporting three `type`s (`email`, `username`, `link`). It grants
workspace membership via an `AccountWorkspace` row on accept. It works
and it ships.

What it does *not* cover:

1. **Entity-level invitations.** Lists and Templates have
   `authorization_rules.authorized_accounts` directly on the entity, but
   no path to put someone there by email. Users today can only collaborate
   by either (a) sharing a URL whose `default_role` already permits the
   needed action, or (b) directly editing the rules with another account's
   id — which they almost never know. Both are friction.
2. **Workspace-as-DjibbList.** `CONTEXT.md` now declares Workspace to be
   a DjibbList-shaped DO (`DjibbWorkspace extends DjibbList`). Once
   workspace membership lives in the workspace's own
   `authorized_accounts`, the existing `workspace_invitations`
   table's accept path — which inserts into `AccountWorkspace` — becomes
   the legacy surface.
3. **A coherent invitee experience.** Even today's workspace invites
   route through `/invites/<token>`, a bearer-token URL that's easy
   to forward, hard to revoke cleanly, and conceptually distinct from
   any other djibb auth flow. As entity invites land, the friction of
   maintaining a third state machine (auth, authz, invite-token) compounds.

We also want the design to respect the **"djibb uses itself"** principle
(`CONTEXT.md` → Design principles): wherever reasonable, internal
mechanisms reuse djibb's own primitives rather than building parallel
infrastructure.

## Decision

**Invitations are tokenless, DO-resident, and pull-filtered.** The
mechanism is identity-kind-agnostic at the schema level, with email as
the v1 concrete case.

### The two steps

An invitation is the *authorization* half of a two-step flow that does
not introduce its own bearer token:

1. **Authentication** is the auth layer's job. Today: OAuth provides
   `email_verified`. Future: magic-link sign-in extends this to
   non-OAuth-provider addresses. Output: a session whose Account has
   verified identity `(kind, value)` — for email, `(email, "bob@x.com")`.
2. **Authorization** is the invitation system's job. When the
   authenticated user visits the target entity (or their invitations
   inbox), the system matches their verified identity against pending
   invitations. A match surfaces an Accept affordance.

The invitation record carries **no bearer token**. A token would only
be needed to identify the recipient — and we know them by identity_kind.
The notification email contains a next-URL (e.g., `/l/<suffix>` or
`/invitations`), not an accept token; forwarding it is harmless because
the forwardee cannot complete step 1 as the invitee.

### Storage

**The pending invitation lives inside the target entity's own DO**,
under a `pending_invites/<lowercased_identity_value>` key (for email).
The DO is authoritative.

A thin D1 table `entity_invitations_index`, derived from DO state via
the existing ADR 0003 emit pipeline, exists for two read paths the DO
cannot answer alone:

```sql
CREATE TABLE entity_invitations_index (
    target_id TEXT NOT NULL,
    target_type TEXT NOT NULL,         -- 'list' | 'template' | 'workspace'
    identity_kind TEXT NOT NULL,       -- 'email' (v1); 'username', 'account_id' (future)
    identity_value TEXT NOT NULL,      -- lowercased for email
    role TEXT NOT NULL,
    inviter_account_id TEXT NOT NULL,
    status TEXT NOT NULL,              -- 'pending' | 'accepted' | 'revoked' | 'expired'
    time_created INTEGER NOT NULL,
    time_expires INTEGER NOT NULL,
    time_accepted INTEGER,
    PRIMARY KEY (target_id, identity_kind, identity_value)
);

CREATE INDEX idx_invites__by_identity
    ON entity_invitations_index(identity_kind, identity_value, status);
CREATE INDEX idx_invites__by_inviter_time
    ON entity_invitations_index(inviter_account_id, time_created);
```

It powers:

- **"What's pending for me?"** Lookup by `(identity_kind, identity_value, status='pending')` across all of a session's verified identities. The DOs themselves cannot answer this without a fan-out scan.
- **Cross-target rate limits.** `WHERE inviter_account_id = ? AND time_created > now() - 1h` for a single-query rate cap.

The index is **derived** — entity DOs are authoritative. If they desync,
the DO wins and the reconciliation alarm (ADR 0007) converges them.

### Identity kind: generalized but small

At v1 only `identity_kind = 'email'` is implemented. The schema is
identity-kind-agnostic because:

- The existing `workspace_invitations` already discriminates the same
  way (`type: 'email' | 'username' | ...`).
- Adding `username` later is a column value + a resolve-username
  helper + a match-dispatch case, not a migration.
- Documenting the abstraction now correctly names what an Invitation is:
  a pending grant on a provable identity. Email is a coincidence of v1.

`identity_kind = 'username'` and `'account_id'` are sketched but not
implemented. They are not Share Links (see below).

The discriminator is also stable across the Account-model evolution
described in **ADR 0010**. Pre-accept, the invitation indexes by
`identity_value` (email) because no Account need exist yet. Post-accept,
the membership lives in `authorized_accounts` keyed by Account ID — and
Account ID is stable across any future change to email schema (multi-email
per Account, change-email flow, etc.). So the v1 email-keyed match
surface and a future Account-ID-keyed membership coexist without
either constraining the other.

### PII gating via pull filter

Email addresses are PII. Pending invites live on the DO, whose state
flows to clients via Replicache pull. Naïvely, every editor/viewer of
the entity would see the email list.

**The pull handler role-filters `pending_invites/*` keys**, emitting
them only to subscribers whose role is in `OWNER_ROLES`. This requires:

- **Cookie semantics include role-version.** Promotion to owner causes a
  fresh pull that includes the previously-filtered keys. The cookie
  encodes `(entity_version, requester_role_version)` so role-change is a
  pull-relevant state change.
- **Demotion emits `op: 'del'`.** When an owner is demoted, their next
  pull emits del operations for the cached `pending_invites/*` keys,
  evicting them from the client's Replicache cache. Pre-demotion
  in-memory copies are not recoverable — but the user had legitimate
  access until the demotion instant, so this is acceptable.
- **The D1 emit drops `pending_invites/*`.** The read-index emit
  excludes invite keys entirely; the *separate* `entity_invitations_index`
  is the only D1 surface that contains identity values, and it is
  HTTP-gated by owner-role checks at every read path.

The pull filter is the load-bearing security boundary. It must be
tested directly (a viewer subscriber's pull MUST NOT contain
`pending_invites/*` keys) and integrated into the broader pull pipeline
with discipline. Its mechanism is generally useful — any future
per-role hidden state (audit trails, soft-delete moderator views,
owner-only annotations) reuses the same machine.

### Independent grant axes

Accepting an entity invite grants access to *that entity only*. It does
**not** create an implicit Workspace membership, even when the entity
lives in a personal Workspace. The auth model already supports this:
access is the union of (entity-direct grant via `authorized_accounts`)
∪ (workspace-member implicit grant per the `@UPGRADE` direction in
`auth/rules.ts`). Both axes grant independently; neither implies the
other.

Concretely: Alice shares "Weekend BBQ" (in her personal Workspace)
with Bob. Bob ends up in `authorized_accounts` on the entity. Bob is
not a "guest" or "member" of Alice's personal Workspace. Bob has no
visibility into Alice's other Lists. Bob's surface for finding
"Weekend BBQ" again is his "shared with me" view — not Alice's
Workspace.

### "Shared with me" — v1 D1, end-state DO

The recipient needs a surface to find entities they've been granted
on across all DOs without scanning everything. At **v1** this is a
D1 derived index:

```sql
CREATE TABLE account_authorizations (
    account_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    role TEXT NOT NULL,
    time_granted INTEGER NOT NULL,
    PRIMARY KEY (account_id, target_id)
);
```

Emitted from entity DOs on `authorized_accounts` mutations (ADR 0003
pattern).

The **end-state**, deferred but explicitly named: Account itself is a
DjibbList-shaped DO, and "shared with me" is a real djibb list whose
items carry `references_entity_id` pointing at shared entities. That
refactor sequences *after* Workspace-as-DjibbList and is a
swap-the-source migration that does not disturb the auth model. The
v1 D1 index's columns mirror what the future account-list items will
carry, so nothing paints into a corner.

### Verbs: Revoke vs Remove

The Invitation and Membership lifecycles are distinct state machines
on distinct records, and the UI surfaces them with distinct verbs:

| State              | Verb           | Surface                          | Friction              | Mechanism                |
|--------------------|----------------|----------------------------------|-----------------------|--------------------------|
| Pending invitation | **Revoke**     | Share UI "Pending invitations"   | None — re-invite cheap| `revokeInvitation` mutator |
| Accepted membership| **Remove access** | Share UI "People with access" roster | Cmd+Z (inverse) | `setListAuthRules` (existing) |

Once an Invitation transitions to `accepted`, it is no longer an
Invitation — the membership is the live object. The invitation row
is retained with `status='accepted'` and `time_accepted` populated
purely as audit; it is hard-deleted on entity cascade-delete (ADR 0008)
and optionally pruned periodically.

This split also drives the natural-key behavior on the index: the
partial unique key on `(target_id, identity_kind, identity_value)` with
`status='pending'` makes re-inviting an existing member surface as
"already a member; change their role in the roster instead" rather
than as a duplicate-pending-invite collision.

### Other policy defaults

- **Expiry:** 7 days from creation. Lazy-expire on read (no cron).
- **Per-inviter rate limits:** 10 invites / hour and 25 outstanding,
  across all targets, per inviter. Cross-target because the abuse
  vector is the inviter, not the inviter on a specific entity.
  Numbers mirror today's `workspace_invitations` for consistency.
- **Inviter eligibility:** must be in `OWNER_ROLES` on the target
  entity. Mirrors `setListAuthRules`'s `requiredRole`.
- **Email send infrastructure:** `workers/src/email`. Template varies
  by `target_type` ("invited you to edit a list" /
  "...a template" / "...a workspace"). CTA links to the entity URL with
  `?from_invite=1` so the entity-page banner can render the invite-claim
  affordance even before the D1 emit has propagated (one-shot lookup
  fallback).
- **Recipient discovery:** dual surface — entity-page banner ("Alice
  invited you to edit. Accept?") **and** a canonical `/invitations`
  inbox listing all pending invites across the account's verified
  identities. The email links to the entity; the inbox covers the
  lost-email case.

## Alternatives considered

Five shapes were on the table; the first four were ruled out for
reasons named below. The fifth was deferred.

### (1) One generalized D1 invitations table

Rename/extend `workspace_invitations` with `target_type` and
`target_id` columns; entity invites become rows in the same table.

Rejected: collapses the "DO is authoritative for entity authorization"
boundary. Accept becomes a two-phase commit (D1 mark accepted + DO
mutate `authorized_accounts`) with no atomicity. The shared columns
are cosmetic compared to the genuinely-different invariants on
workspace vs. entity invites.

### (2) Two parallel D1 tables sharing helpers

Keep `workspace_invitations`; add `entity_invitations`. Factor token
gen, rate-limit query, accept matching into `workers/src/invitations/shared.ts`.

Rejected after recognizing Workspace is itself a DjibbList — once
workspaces become DOs, the workspace vs. entity distinction collapses
at the substrate level, and maintaining two D1 tables for what is
fundamentally one primitive is duplication.

### (3) DO-resident with PII in Replicache

Pending invites in the entity DO, surfaced through normal Replicache
pull to all subscribers.

Rejected: leaks invitee email addresses to every editor/viewer of the
entity. Considered a deal-breaker until the pull-filter approach
re-opened the option.

### (4) DO-resident with pull filter (chosen)

The model above.

### (5) Account-as-DjibbList for "shared with me" *now*

Bundle account-as-DO into the invitation work; "shared with me" is
the account-DO's item list.

Deferred. The end-state is desired; the sequencing is wrong. Doing it
concurrently with workspace-as-DO and invitations couples three
in-flight architectural shifts. The v1 D1 derived index achieves the
same UX with code we already know how to write, and the future swap
is a localized refactor that doesn't touch the auth model.

## Out of scope

- **Share Links.** Bearer-token, anyone-with-the-URL invites. A
  distinct primitive (no recipient identity, reusable, different
  state machine). Will get its own ADR when the UX is concrete.
  Probably co-resident on the same DO under a `share_links/*` key
  with its own pull-filter rule.
- **SMS / phone invitations.** Far future. The identity-kind
  discriminator leaves the door open.
- **Generic auth-provider plugin layer.** Yak. Email + magic-link +
  existing OAuth is enough surface for the foreseeable.
- **Multi-email per Account.** Explicitly rejected in `CONTEXT.md`'s
  Account entry. The multi-Account-per-session UX covers the same
  ground.
- **Invitee-side accept friction.** v1 has no "are you sure you want
  to accept?" modal. The recipient clicked an invite email and signed
  in; consent is presumed. Decline is implicit via ignore-until-expiry.
  A future explicit Decline action that marks `status='declined'` and
  notifies the inviter is reasonable but not blocking.

## Sequencing

Implementation depends on two upstream pieces:

1. **Workspace-as-DjibbList lands.** Without it, workspace invites
   stay on the legacy `workspace_invitations` path and the unified
   model is split-brain.
2. **Magic-link auth lands.** Without it, email invitations dead-end
   for any recipient whose email isn't on a supported OAuth provider.
   Email invitations can ship before magic-link only if the inviter
   accepts that some invitees will be unable to claim. **Strongly
   prefer to ship magic-link first.**

Within the invitations work itself:

1. The D1 `entity_invitations_index` and `account_authorizations`
   tables, plus the emit handlers from the entity DO.
2. The pull-filter changes to the DO's pull handler (with role-versioned
   cookies and del-on-demote).
3. The DO mutators: `inviteByIdentity({ identity_kind, identity_value, role })`,
   `revokeInvitation({ identity_kind, identity_value })`,
   `acceptInvitation({ identity_kind, identity_value })`. All
   inverse-backed per ADR 0005.
4. The email template + send path, hooked off the entity DO's mutation
   outcome (or a thin queue if delivery is async).
5. The Share UI's "Pending invitations" section and the `/invitations`
   inbox route.
6. Cascade-delete integration (ADR 0008): hard-delete of a target DO
   batches `DELETE FROM entity_invitations_index WHERE target_id = ?`.

## Consequences

**Positive:**

- One invitation mechanism across List, Template, and Workspace.
- No bearer-token invitation flow; auth and authorization stay
  separate.
- Cascade-delete-friendly — pending invites die with the DO they
  belong to.
- The pull-filter machine is reusable for any future per-role hidden
  state.
- The identity-kind discriminator makes username/account-id targeting
  a small additive change.

**Negative / load-bearing:**

- The pull filter is a security boundary. Tests must directly assert
  that non-owner pulls do not contain `pending_invites/*` keys, and
  that demotion emits del ops. A regression here is a PII leak.
- ADR 0003's emit pattern extends to terminate at other DOs (when
  account-as-DjibbList lands later). Today's emits go to D1 only;
  that extension is a real generalization.
- Magic-link auth is on the critical path for full coverage. Until
  it lands, email invitations to non-OAuth-provider addresses
  dead-end.
- The `entity_invitations_index` is derived state with all the
  ADR-0007 reconciliation responsibilities. Drift between DO truth
  and the index is a possibility the alarm has to converge.

**Neutral:**

- `workspace_invitations` stays in place during the transition. Once
  Workspace-as-DjibbList lands and workspace membership lives in
  `authorized_accounts`, `workspace_invitations` becomes redundant
  and can be migrated to the unified path.
