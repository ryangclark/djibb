# ADR 0018: Sidecar Agent runtime — concierge DOs as clients of the entity port

- **Status:** Proposed
- **Date:** 2026-06-15

## Context

djibb is about to grow model-driven, scheduled, channel-connected
behavior. The first instance is the closeout prompt of the
self-improvement loop (ADR 0017): on a timer, after an instance is spent,
ask the user what they learned, parse the reply, and write proposals back.
That needs three capabilities djibb doesn't have wired: **scheduling**, an
**LLM call**, and **inbound channels** (email first). More will follow —
"cc the List on a real email thread," forward-an-email-with-a-directive,
Slack, webhooks.

The question this ADR settles is *where that behavior lives*, because the
obvious-looking answer is wrong. `DjibbList` (ADR 0011) is the universal
entity DO — but it is heavily customized: Replicache sync, its own
`list_elements` schema, its own `alarm()` driving ADR 0007
reconciliation, its own auth. The Cloudflare **Agents SDK** (`agents`)
offers exactly the missing primitives — `Agent extends DurableObject`
with `schedule()` / `scheduleEvery()`, `onEmail()` / `routeAgentEmail()` /
`replyToEmail()`, `this.sql`, and a `setState` client-sync channel. An
agent *is* instanced compute + instanced storage, which is what a DO
already is. So the temptation is to make `DjibbList` an `Agent` subclass.

Two collisions make that the wrong move:

1. **The SDK owns `alarm()`** to drive its scheduler. `DjibbList`
   overrides `alarm()` for reconciliation (ADR 0007) — they would fight
   over the single alarm slot.
2. **`setState` is a parallel sync universe** to Replicache. `DjibbList`
   would inherit a client-sync mechanism it actively does not want.

## Decision

### A. Adopt the Agents SDK, but only as a *sidecar* — never `DjibbList`'s base class

New model-driven behavior lives in a **separate Agent DO** (the first is
the "concierge," ADR 0017 / the closeout plan). `DjibbList` is never
converted. Confining the SDK to a sidecar means we get its runtime
without the two collisions above, and the dependency stays **rippable** —
removable without touching the entity core.

### B. A sidecar agent is a *client of the entity port*, not a second authority

A sidecar talks to `DjibbList` over **RPC**, the same way the CLI and the
email-as-CLI flows do. It is just another consumer of the entity port
(ADR 0014 `EntityStore` / protocol split). It **never** touches
`list_elements` or Replicache directly; `DjibbList` remains the sole
authority over entity state (ADR 0003, ADR 0011). The agent schedules,
listens, calls a model, and then issues ordinary mutations/RPCs — it
proposes, the entity DO disposes.

### C. Runtime primitives only — not the harness

We take the SDK's **durable runtime**: `schedule` / `scheduleEvery`,
`onEmail` / `routeAgentEmail` / `createAddressBasedEmailResolver` /
`replyToEmail`, and `this.sql` for the agent's own bookkeeping. We do
**not** adopt the "Project Think" harness or any opinionated agent loop —
djibb owns its own control flow. Outbound mail continues through the
existing `EMAIL` binding (Cloudflare Email Service), not a second sender.

**On scheduling, precisely (so this doesn't overclaim).** The SDK's
`schedule` is **not a Cloudflare service** — it is library code over the
*same* `ctx.storage.setAlarm()` primitive `DjibbList`'s home-rolled alarm
already uses. What it adds is an *abstraction*: a `cf_agents_schedules`
SQLite table plus an `alarm()` dispatcher that runs all due tasks and
re-arms to the next-soonest, with retry and four modes (one-shot / delay /
cron / interval). It is an instance method **bound to the `Agent` class**
(it depends on the Agent constructor's state), so it **cannot be imported
onto `DjibbList`** without making `DjibbList` an Agent — which §A rejects.

The consequences for who-schedules-what:

- **Sidecar agents get real `schedule()` for free** — they *are* Agents.
  The concierge schedules its closeout prompts natively; no work.
- **`DjibbList` keeps its home-rolled `alarm()`.** For its one current job
  (ADR 0007 reconciliation) home-rolled is not worse — the SDK's only
  advantage is *multiplexing many tasks*, which a single-purpose alarm
  doesn't need. The earlier framing that the SDK "dissolves the
  single-alarm friction" applies to **sidecars**, not to `DjibbList`.
- **If `DjibbList` ever needs a *second* scheduled reason**, steal the
  *pattern*, not the dependency: the table + re-arming dispatcher is ~tens
  of lines, and the `agents` source is the worked example to copy from.
  Reimplementing sidesteps both the class-binding and the dependency.
- **Relocating reconciliation onto a sidecar's `scheduleEvery`** (concierge
  schedules "reconcile entity X" → RPC into `DjibbList`) is *possible* but
  **not adopted**: it couples core reconciliation availability to a sidecar.
  Reconciliation stays in `DjibbList`.

### D. This is a boundary rule, not a one-off

Every future agent — capture bots, channel listeners, schedulers — is a
sidecar behind the port, by this same rule. The ADR exists so that "an
agent is a DO" never becomes "so put it *in* the entity DO." If a single
sidecar ever needs to *be* authoritative over its own entity-shaped
state, that earns a new ADR; the default is client-of-the-port.

## Alternatives rejected

- **Convert `DjibbList` to an `Agent`.** Fights Replicache (`setState`)
  and the reconciliation alarm; inherits SDK surface area we don't want;
  couples the entity core to a young dependency.
- **Steal the patterns, take no dependency.** Re-implement
  schedule-multiplexing over our own `alarm()` (~tens of lines) and an
  Email Worker with our own address resolver. Legitimate, but it
  reimplements the fiddliest parts (inbound email routing) for no real
  benefit, given the sidecar already quarantines the dependency.

## Consequences

- New runtime dependency (`agents`), deliberately confined to sidecar DOs
  and to runtime primitives — small, isolated blast radius.
- **First inbound channel.** Everything prior (invites, transfers,
  magic-link) was outbound-only; inbound email is a new abuse/spam surface
  to gate (token-in-the-address, see the concierge plan).
- Scheduling stops being a scarce single-alarm resource **in sidecars**
  (which get the SDK's multiplexed scheduler); `DjibbList` keeps its
  home-rolled `alarm()` and is unchanged by this ADR. See §C for the full
  who-schedules-what tree and the steal-the-pattern escape hatch.
- Realizes the **delivery** side of ADR 0017; the first concrete build is
  `docs/plans/closeout-concierge.md`. The self-improvement loop (ADR 0017)
  does not depend on this ADR — it could be driven by an in-app prompt —
  but this ADR is how it (and everything after it) reaches the user.
