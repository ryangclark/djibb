# ADR 0013: Account-level synced view — considered, deferred

- **Status:** Deferred (considered; not adopted — see Decision)
- **Date:** 2026-06-10 (deferred 2026-06-12)
- **Layer:** server-cf

## Context

A one-line breadcrumb in `docs/workspaces.md` said `current_workspace_id`
"will likely migrate to a Replicache Client View Record (CVR) … design
with that in mind." Grilling that breadcrumb open expanded it into a
full design — a thin standalone `DjibbAccount` Durable Object serving a
CVR-backed Replicache pull for an **account-spanning view** (workspace
memberships now; notifications, shared-with-me later). This record
captures what that exploration found, why it was **not** adopted, and
the genuine decision it deferred — so the same breadcrumb doesn't
re-grow the same design.

The exploration was prompted by a real, present pain: the workspace
switcher reads memberships via a one-shot REST fetch
(`GET /a/:suffix/workspaces`, served from the D1 `entity_memberships`
projection) and goes stale the moment an invite, rename, or removal
lands while the app is open.

## Decision

**Do not build a `DjibbAccount` DO or a CVR pull now.** Solve the
present pain at its actual size, and defer the account-spanning-view
substrate to the feature that justifies it.

1. **The stale switcher is fixed client-side.** Revalidate the existing
   `GET /a/:suffix/workspaces` fetch on window-focus and after the
   actor's own membership-changing actions. No new DO, no CVR, no poke,
   no websocket. The switcher has no Replicache subscription and no
   websocket today (websockets are strictly per-entity, `?c=`/`?l=`,
   ADR 0006) — so there is nothing for CVR to be a strategy *of*, and
   nothing to poke.

2. **`current_workspace_id` stays client-local** (localStorage), as
   today. By the explored design's own bootstrap rules a synced copy is
   consulted only on a brand-new device with zero history — a marginal
   nicety not worth a DO. `current_account_id` is permanently client-
   local: authenticating *is* selecting an account, and different
   accounts may be live in different tabs at once, so it must never be
   server-synced. (This last point survives the deferral — it is a real
   constraint regardless of how the view is later built.)

3. **The account-spanning-view substrate decision is deferred to
   notification design**, where it must be made *consciously* against
   the fork below — not stumbled into via a pull-strategy breadcrumb.

## The deferred fork (the thing to decide later, on purpose)

The explored design's headline claim was "an account-spanning view's
read-set changes via *grants by other people*, so per-entity version-
diff can't express it — therefore CVR." That is true only under a
particular, unstated sub-choice. The real fork is:

- **Fan-out-write** — a grant *emits a write* into each affected
  account's own substrate (their shared-with-me / membership entity).
  That write bumps *that* entity's version, so ordinary Replicache
  version-diff works and the view stays on the universal `DjibbList`
  substrate. **This is already ADR 0009's stated end-state**
  ("Account itself is a DjibbList-shaped DO… emit terminates at other
  DOs") and ADR 0011's direction (`inbox`, `shared_with_me` reserved as
  `slot` values on `type: 'list'`). Cost: more emit fan-out surface.

- **Read-time-derive** — the account reads a shared D1 projection at
  pull time and gets no write fanned in. Now the read-set changes
  invisibly to version-diff, so it needs CVR (or a full-state pull) and
  a non-`DjibbList` DO class. Cost: a new DO class + CVR machinery, and
  it reverses 0009's end-state and 0011's "djibb uses itself" substrate
  thesis for the account/inbox/shared-with-me family.

The explored design silently chose read-time-derive (sold as "no second
projection, no new emit fan-out") and booked the resulting CVR + new DO
class as a *saving* — without noticing ADR 0009 had already weighed this
exact trade and chosen fan-out-write. That mis-framing is the weed this
record exists to pull. When notifications/shared-with-me are designed,
pick fan-out-write vs read-time-derive explicitly, with 0009's
end-state as the standing default.

## Considered (and not adopted now)

- **Thin `DjibbAccount` DO + CVR-backed pull**, reading
  `entity_memberships` at pull time, with workspace DOs poking affected
  account stubs from the post-commit tail. Not adopted: the present pain
  needs none of it; a poke requires the very account-addressable
  channel (the DO) it was meant to avoid; and it reopens ADR 0009/0011
  without acknowledging them.
- **Full-state pull instead of CVR** (reset-patch every pull, no CVR
  bookkeeping): the lighter way to serve a tiny account view *if* a DO
  is ever built — noted for the deferred decision, not adopted now.

## Consequences

- The switcher fix is a few lines in `pages/src/lib/session.svelte.js`
  (revalidate-on-focus); it adds no architecture.
- Instant cross-account push (an invite appearing without a refocus) is
  deferred along with the DO. Accepted: membership changes are rare and
  non-urgent, and that push is exactly what the notification feature
  will need a channel for.
- ADR 0009's account-as-DjibbList end-state and ADR 0011's
  `inbox`/`shared_with_me` slots remain the standing direction for the
  substrate question. This record does not change them; it stops a
  breadcrumb from quietly reversing them.

## References

- ADR 0003 — DO as authority; D1 as derived read index (the
  `entity_memberships` projection the switcher reads).
- ADR 0006 — clientID-tagged per-entity websockets; the "non-list DO
  may eventually grow channels" open question is where an account
  channel would land *if* built.
- ADR 0009 — Invitations; §"Shared with me — v1 D1, end-state DO" is
  the fan-out-write end-state this record defers to.
- ADR 0011 — `DjibbList` as universal entity substrate; `SlotEnum`
  reserves `inbox` / `shared_with_me`.
- `docs/workspaces.md` — Phase 5 switcher-revalidation item.
</content>
</invoke>
