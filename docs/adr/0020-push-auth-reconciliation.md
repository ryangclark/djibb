# ADR 0020: Push-time authorization reconciliation — ack vs. throw

- **Status:** Accepted; implemented (see commit `6ecc5f741`,
  `packages/server-cf/src/list/durable_object.ts` `handleMutation`, and
  `packages/server-cf/test/pushAuthReconciliation.test.ts`)
- **Date:** 2026-06-17
- **Layer:** protocol

## Context

Replicache is optimistic: the client applies a mutation locally, queues it,
and pushes it. The server processes each mutation, advances a per-client
`lastMutationID`, and the next pull returns authoritative state plus that
ID. Replicache rebases — authoritative snapshot, then replay of pending
mutations whose `id > lastMutationID`. Once the server advances
`lastMutationID` past a mutation, its optimistic version is **dropped** and
rolled back.

The load-bearing consequence: **how the server responds to a mutation it
refuses to apply determines whether the client can ever reconcile.**

- A **non-200 push** is read by Replicache as a *transient* failure. It
  keeps the whole push pending and **retries forever**. `lastMutationID`
  never advances; the optimistic write never reconciles.
- A **200 push that advances `lastMutationID` without writing** ("skip-and-
  ack") tells Replicache the mutation was *processed* (and had no effect).
  The optimistic write rolls back on the next pull.

ADR 0009 introduced skip-and-ack for invitation-family *permanent* failures
(stale/gone, slug claim) precisely to avoid wedging the retry loop, but
never stated the general rule and never addressed authorization denials.
Authorization (`requiredRole`) denials were left throwing — returning a
403 for the whole push.

Two real failures forced the decision:

1. **The wedge (the bug).** Opening an entity that already exists server-
   side — the homepage example Blank (a read-only `viewer`), or any direct
   nav to `/t/[id]` / `/l/[id]` — fired an *optimistic* `initList`. For a
   `viewer` Blank the role gate denied it; the 403 wedged the push in an
   infinite retry, spamming the console and briefly flashing an empty shell
   over the real content.

2. **The data-loss trap.** The naive fix — skip-and-ack *all* auth denials
   — would silently discard real edits. `HandleSession` blanks an
   expired/invalid session cookie to `null` rather than throwing, so an
   **owner whose token expired while editing offline** arrives looking
   identical to an anonymous viewer: empty `authorizedAccounts`, role
   resolved to the entity's `default_role` (`restricted` on an owned list),
   gate denies. Acking that away would throw out the owner's offline work.
   djibb auth has **no refresh token** (magic-link/OAuth + HttpOnly cookie,
   ADR 0010), so recovery is necessarily an interactive re-auth — the
   pending mutation must survive until then.

The discriminator that separates a *permanent* denial from a *transient*
one is therefore **whether the request is authenticated**, not the role.

## Decision

### Server: ack iff authenticated, else throw

In `handleMutation`, a `requiredRole` denial branches on
`authorizedAccounts`:

- **Authenticated** (`authorizedAccounts.length > 0`), role genuinely too
  low — a signed-in viewer, or an editor whose access was revoked. This is
  a **permanent** denial: emit the `auth` outcome on the per-mutation
  channel (ADR 0006) for a toast, then **skip-and-ack** — advance
  `lastMutationID`, write nothing. Replicache reconciles the optimistic
  write on the next pull instead of wedging.

- **Unauthenticated** (empty `authorizedAccounts` — includes an expired/
  blanked session) — this may be an owner whose token lapsed mid-offline-
  edit. **Throw.** Replicache keeps the mutation pending and retries; once
  the client re-authenticates with a fresh cookie, the same push lands with
  no data loss.

Skip-and-ack never applies a write — the role gate already rejected it. The
ack only tells the client "processed, no effect," never "applied."

### Client: prevent the doomed push at the source (`?new=1`)

The optimistic `initList` is the create-list mechanism, fired when the
local Replicache store is empty. An empty store is ambiguous: a brand-new
entity, or a fresh client opening an *existing* one. We disambiguate with a
`?new=1` marker that only the "+ New list/template" buttons set. Every other
arrival — direct nav, deep link, invitation link, the homepage example —
opens read-only and never fires init. This subsumes the older
`from_invite` skip.

The two layers are complementary: the client guard stops the *common*
doomed push (and the empty-shell flicker); the server policy is the safety
net that makes *any* auth-denied push reconcile cleanly rather than wedge.

## Alternatives considered

### (1) Always throw on auth denial (status quo before this ADR)

Preserves offline edits (retry never discards), but wedges the push loop
forever on any *permanent* denial — the reported bug. Rejected.

### (2) Always skip-and-ack on auth denial

Reconciles every permanent denial cleanly, but silently discards an offline
owner's edits the moment their token expires (they present as
unauthenticated). Unacceptable data loss. Rejected.

### (3) Client-side prevention only (`?new=1`, no server change)

Fixes the reported homepage bug, but leaves the general reconciliation hole:
any other path that queues an auth-denied mutation (a stale UI affordance, a
race, a future mutator) still wedges. The server policy is what makes the
invariant general. Rejected as insufficient on its own; kept as the
complementary prevention layer.

## Consequences and subtleties

- **The envelope cross-account check is the primary protection for the real
  offline-owner case.** A mutation authored while authed carries
  `accountId: <owner>` in its envelope. On reconnect with an empty session
  it claims an account the session doesn't hold, so it is rejected by the
  envelope guard (`handleMutation`) which throws *before* the role gate.
  The authenticated/unauthenticated role-gate split is the belt to that
  suspenders, and covers anonymous-authored (`accountId: null`) edits on a
  now-restricted entity.

- **"Safe but invisible."** This makes offline/expired-session edits safe
  (preserved, retried) but gives the user no signal that they're signed out
  with unsynced work. The UX that turns "safe but stuck" into "recoverable"
  is deliberately deferred: issues #6 (session-expired banner), #7 (sync-
  status indicator), #8 (silent session renewal — HITL, schedule with auth
  hardening).

- **Bad-URL pull-404.** Because direct nav no longer optimistically inits,
  navigating to a *genuinely nonexistent* list id (no `?new=1`) now shows
  "Loading…" with a repeating pull-404 instead of silently fabricating a
  phantom list. Affects only stale/typo'd URLs; a proper not-found UI is a
  reasonable follow-up.

- **Tests.** Both branches are pinned side-by-side in
  `pushAuthReconciliation.test.ts` (incl. the offline-edit claim); the
  browser wiring is covered by `e2e/example-list.sh`. Two
  `entityInvitations` role-rejection tests were updated from "throws" to
  "skip-and-acks" to match the authenticated-denial behavior.

## Relations

- **ADR 0005** (undo and inverse mutators) — the undo runtime consumes the
  `auth` outcome emitted here.
- **ADR 0006** (clientID-tagged websockets for outcome routing) — the
  per-mutation `auth` outcome channel.
- **ADR 0009** (invitations) — origin of the skip-and-ack-over-4xx posture
  for permanent failures; this ADR generalizes it and resolves the auth
  carve-out.
- **ADR 0010** (authentication — magic-link floor) — the session model (no
  refresh token) that makes the unauthenticated-throw branch necessary.
