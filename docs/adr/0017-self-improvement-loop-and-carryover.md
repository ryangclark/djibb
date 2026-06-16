# ADR 0017: The self-improvement loop — instance→Template learning via carryover

- **Status:** Proposed (stub — core shape committed; §Open questions unresolved)
- **Date:** 2026-06-15

## Context

djibb's entity substrate (ADR 0011) already models the two halves of a
learning loop without ever naming the loop itself:

1. **The lineage edge exists but is inert.** Every minted List carries
   `forked_from_id` pointing at the Template it was instantiated from
   (`mintFromBlank` / `initFromTemplate`). Today that edge is write-once
   provenance. It is also, unused, the exact pointer along which
   *improvements discovered while using an instance* should flow back up
   to the Template — so the *next* instance is born better. The
   `contribute` / `promote` rails (the cross-DO upstream write) already
   traverse this edge; the loop closes them.

2. **The distinction is in the founder's head, not the docs.** Two ideas
   have informed design implicitly without an ADR: (a) the
   **self-improvement cycle** — a Template gets better every time one of
   its instances is used — and (b) the **update-Template vs
   update-instance** distinction. Nothing in the codebase forces a
   producer of notes to declare which it means, so notes default to the
   instance and Templates never compound.

3. **The harvest moment is *after* the instance is spent — and most
   learnings are for the *next* instance, not the spent one.** "We ran
   out of fire starters on the Buena Vista camping trip" is harvested once the
   trip is over; the trip already happened, so the spent instance is
   mostly read-only history. "Refill the fire-starter tin" is not a
   change to *that* trip — it's a note for next time. This ADR is about
   *what the loop means and how it's modeled*; the **delivery** of the
   prompt (scheduling, channel) is a separate concern — see ADR 0018
   (sidecar Agent runtime) and `docs/plans/closeout-concierge.md`.

Treated separately these are provenance, a notes feature, and a timing
detail. Treated as one they are a single thing: **a loop that turns a
spent instance into a better Template, where each learning carries a
*durability* — does it touch this trip, the next trip, or every trip?**

## Decision

### A. The durability axis: `amend` / `carryover` / `canon`

The unit of feedback is a **proposal**, classified not by *where* it
lands but by *how durable* it is across the instance series:

```ts
type CloseoutProposal = {
    scope: 'amend' | 'carryover' | 'canon'; // REQUIRED — default 'carryover'
    op: MutatorName;   // e.g. 'createListItem', 'setItemFields'
    args: unknown;     // mutator body
    status: 'pending' | 'accepted' | 'rejected';
};
```

- **`amend`** — apply to *this* (spent) instance. **Rare**: only when the
  instance is still in use, or you're correcting the historical record.
  The common case is *not* this — the trip already happened.
- **`carryover`** (**default**) — for the *next* instance only. A
  one-shot suggestion, consumed at the next instantiation, that must
  **not** become permanent. "Refill the fire-starter tin" is true once,
  not forever — putting it in the Template body would nag every future
  trip after it's already done.
- **`canon`** — permanent. Becomes part of the Template body; every
  future instance inherits it. "Never forget bug spray."

`scope` is the load-bearing primitive of this ADR: it is the place the
self-improvement distinction is finally forced into the type system, and
its default (`carryover`) encodes the insight that learnings are mostly
for *next time*, not this time or forever.

### B. Carryover is a system group marked `slot: 'carryover'`; `slot` generalizes to a well-known *role*

`carryover` and `canon` are **not different write paths** — both are
upstream writes to the Template (the `forked_from_id` DO; definitionally
a `contribute` / `promote` call, ADR 0011; no new rail). They differ only
in **which group the item lands in**:

- `canon` → a normal Template group (permanent body).
- `carryover` → the Template's **system carryover group**, marked
  `slot: 'carryover'`.

So **graduation — the "make this permanent" gesture — is just reparenting
an item out of the carryover group into a normal group**: a
`setItemFields(parent_element_ref)` that already exists. The three-way
axis collapses to "which group," reusing every item/group mutator,
Replicache sync, undo, and markdown encoding (ADR 0012). A `meta`-blob
staging area would have had none of that.

**`slot` generalizes from "well-known entity singleton" to "well-known
role."** Today `SlotEnum` (`personal_workspace | inbox | seed_pool`) marks
well-known *entity* rows, and its values already span scopes —
`seed_pool` is one **globally**, `inbox` one **per account** (ADR 0011
§2). `carryover` adds a third scope — one **per parent entity** — and is
the first `slot` to live on a **group** row rather than an entity row.
The value implies the scope, exactly as the existing two already do.

> **Bright line: a slot is a *role label*, not a doorway to entity-hood.**
> A `slot: 'carryover'` group stays **body content** interior to its
> Template — written by a `system`-role mutator (like the cascade-restore
> path), read and rendered like any other group. It does **not** get its
> own DO, its own `authorization_rules`, or its own lifecycle. "Has a
> slot" is decoupled from "is an entity row"; they merely coincided
> before this ADR. Hold this line or every group drifts toward becoming
> an entity.

Two behaviors key off the slot:

1. **The mint flow consumes it.** `initFromTemplate` copies normal groups
   as canon; the `slot: 'carryover'` group's items come into the *new*
   instance as a "↩ from last time" triage group and are cleared from the
   Template (consumed). v1: one undivided triage group — per-item
   target-group memory is deferred (§Open questions).
2. **Mixed authority.** The concierge writes items *in* on closeout
   (system-role mutator); the user pulls items *out* (graduate to canon)
   or accepts them at mint.

The ambitious form (deferred) is **reconciliation learning**: a
structured diff between what the Template *predicted* and what the
instance actually *consumed* (ran out of fire starters → the Template's
suggested quantity was wrong), so Templates improve *quantitatively*, not
just by gaining/losing items — the same mental model as the ADR 0007
reconciliation sweeper, with a human in the loop.

## Open questions

- **`slot`-on-groups schema cost.** `slot` and `meta` are parsed only for
  entity rows today (the `isEntityRowType` gate in `list/sql.ts`) and are
  invisible to the D1 catalog. Extending to groups means teaching the
  *group* parse/render path about `slot` and auditing every assumption
  that `slot ⇒ entity row`. Modest, but real.
- **v1 mint behavior.** One undivided "from last time" triage group
  (simple), or carryover items remember an intended target group and
  distribute back into place (smart; needs per-item target memory)?
  Leaning: triage group first.
- **Reconciliation learning** (Decision B, ambitious form) is out of scope
  for v1 — v1 is gain/lose items + freeform notes. The quantitative
  Template-tuning diff is a follow-up ADR.
- **Instance→instance series edge** ("make next year's trip from *what we
  actually packed last time*, not the pristine Template") is a separate,
  useful project — its own ADR. Today carryover stages on the Template
  (the only rendezvous both instances can see); an instance→instance edge
  would let carryover live on the instance instead.

## Consequences

- The self-improvement loop and the instance/Template distinction are
  finally written down and typed (`scope`), instead of living in the
  founder's head and leaking into features implicitly.
- **`slot` is decoupled from entity-hood** — it becomes the general
  well-known-role mechanism (entity *and* group granularity). Expected to
  recur: future system groups ("suggested," "scratch") are just new
  `slot` values, honoring ADR 0011 §2's "roles, not per-case booleans"
  one level down.
- `forked_from_id` graduates from inert provenance to a live edge — read
  by `mintFromBlank`, now written-back-along by carryover/canon.
- **Delivery is out of scope here.** How the closeout prompt is scheduled
  and how a reply produces proposals lives in ADR 0018 + the closeout
  concierge plan; this ADR would be unchanged if the prompt were an
  in-app card instead of an email.
