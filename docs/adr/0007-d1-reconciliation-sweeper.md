# ADR 0007: D1 reconciliation sweeper via DO alarms

- **Status:** Accepted
- **Date:** 2026-05-16

## Context

ADR 0003 made the Durable Object authoritative for entity metadata and
demoted D1 to a derived read index (`workspace_entities`). Every
metadata-touching mutator — `initList`, `renameList`, `archiveList`,
`setDescription`, `setListAuthRules`, `initFromTemplate` — runs the
mutation against the DO's sql, then synchronously calls
`EmitEntitySnapshotToCatalog(d1, snapshot)` on the way out of the push
handler. The catalog (account → owned entities), the auth fast path
in middleware, and the future workspace browse views all read from
the D1 row.

The emit is fire-and-pray: if D1 is unavailable, if the network blips
mid-write, or if the DO is evicted between the commit and the emit,
the emit fails. The DO logs and moves on. The current rationale —
"the next mutation re-emits" — is true but unbounded: if the next
mutation is a week away, D1 is wrong for a week. ADR 0003's "Open
questions, refreshed" calls this out as the most pressing piece;
every metadata mutator implicitly depends on a backstop that doesn't
exist.

Two further pressures land alongside ADR 0007:

- **The sweeper introduces a second concurrent writer** to
  `workspace_entities`. The current upsert in `entity.ts` has no
  version guard, so a sweeper running concurrently with a fresh
  mutation could overwrite a newer row with an older snapshot. The
  bug is latent today (one writer per DO) but is unsafe to ship the
  sweeper against.
- **The DO already knows its own truth.** Any external sweeper
  (cron worker over D1, periodic scan) would have to round-trip into
  the DO to read current state. The DO is the natural reconciler.

## Decision

### Trigger: per-DO `alarm()`, every 24 hours

Each entity DO sets a recurring alarm 24 hours out. On fire, the
alarm handler re-runs `emitEntitySnapshot()` for its entity row and
re-arms.

24h is a deliberate floor, not a target — the synchronous post-commit
emit handles the steady state, and the alarm exists only as a
safety net for the cases where that emit silently failed. A tighter
cadence trades extra alarm fires (and D1 reads) for a smaller drift
window; the synchronous path already gives near-zero drift on every
write, so the alarm only buys recovery time, not freshness.

Bootstrap: the DO checks `this.ctx.storage.getAlarm()` on the first
push it serves; if null, it schedules the first alarm 24h out. No
migration step is needed because new DOs hit this path immediately
and existing DOs will hit it on their next push.

Retry on failure: if the alarm-driven emit throws, the alarm re-arms
for `min(2× last_retry, 24h)` starting at 5 minutes. The DO records
the next retry interval in storage so it survives evictions. Once
the emit succeeds, the cadence resets to 24h.

### Skip when D1 is already at version N

Before upserting, the alarm handler reads the current D1 row's
`version` for this entity. If it equals the DO's version, the alarm
records a `noop` and re-arms — no UPSERT, no write. If it differs (or
the row is missing), the alarm runs the emit.

The skip path is one extra SELECT per alarm fire. In exchange:

- The 99% case (no drift) skips D1 writes entirely. At 24h cadence
  across many entities this is a meaningful save against D1's quotas.
- The drift case becomes observable: every UPSERT triggered by the
  alarm path means the synchronous emit failed at some point. A
  counter on the divergent branch surfaces emit failures we'd
  otherwise never notice.

### Version-guarded upsert in `EmitEntitySnapshotToCatalog`

The `ON CONFLICT DO UPDATE` clause grows a `WHERE` filter:

```sql
ON CONFLICT(id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    ...
    version = excluded.version
WHERE excluded.version >= workspace_entities.version
```

Equal versions are allowed through (retry-safe replay). Older
versions are silently no-op'd. This makes the upsert safe to call
from any writer at any time — the alarm path, the synchronous emit
path, and any future writer all observe the same monotonic invariant
without having to coordinate.

The guard is a prerequisite to the sweeper, but it's worth landing on
its own: today's single-writer assumption is one DO bug or one
deployment race away from a stale clobber even without the sweeper.

### Defer cross-D1 orphan sweep

D1 rows for entities whose DOs no longer exist (dev-environment
wipes, future hard-delete flows) are out of scope. The DO can't
sweep what it doesn't know about. A `scheduled` worker handler that
walks D1 looking for stale rows is the natural shape and a small
follow-up; it is not needed for the steady-state reconciliation
guarantee this ADR establishes, only for cleanup hygiene.

### Defer content-hash drift detection

The version column is sufficient. A future audit that wanted "did the
content actually change" without bumping the version (e.g. a
migration) can add a content hash then; today every content change
already bumps version, so versions disagreeing is a strict superset
of contents disagreeing.

## Pros and cons against alternatives

### What per-DO alarm wins (vs cron over D1)

- **Read isolation.** Each DO reads its own state directly from its
  own sql; no DO round-trips, no coordination, no shared mutex on a
  cross-account scanner.
- **Cost proportional to fleet.** A cron over D1 walks every row on
  every fire regardless of recent activity. Alarms cost only when
  they fire, and the no-op skip path makes them nearly free in the
  steady state.
- **Reuses existing code.** `emitEntitySnapshot()` is already the
  function we want to call; the alarm handler is a 10-line caller.
- **Survives DO eviction naturally.** Cloudflare persists alarms
  with DO storage. An evicted DO re-hydrates when its alarm fires.

### What cron-over-D1 would have won

- **Orphan detection.** A scanner can notice "this D1 row's DO has
  no recent activity and isn't responding to a ping." The alarm path
  can't — it requires the DO to be the one noticing.
- **Single observability surface.** All sweeper activity in one
  worker handler instead of distributed across DO logs.
- **No bootstrap concern.** A cron handler runs immediately on first
  deploy. Alarms require each DO to set its first alarm during a
  push, which means a DO that never serves another push (cold,
  pending-archive) never sweeps. Acceptable for this design — such
  DOs have nothing to drift toward — but a tradeoff worth naming.

Cron remains the right shape for the orphan-D1-row sweep noted
above. The two designs compose.

### What polling on every push would have won (vs cadence-based)

- **Zero alarm budget.** Just do the read-and-maybe-emit on every
  push handler. No alarms, no bootstrap.
- **Loses the drift-while-idle case** — exactly the case the sweeper
  exists to handle. Rejected: this is the failure mode ADR 0003
  flagged.

### What no version guard would have won

- **Simpler SQL.** Six fewer characters.
- Rejected outright: introduces a downgrade hazard the moment a
  second writer enters the system, and the cost is trivial.

## Consequences

**Positive:**

- The "next emit recovers it" claim from ADR 0003 becomes true with
  a bounded recovery window (24h worst case).
- The upsert is now safe under concurrent writers, removing a latent
  hazard independent of the sweeper.
- Drift is observable: every alarm-triggered emit (vs alarm-triggered
  skip) is a signal that the synchronous path failed for that
  entity. Counts are aggregable from DO logs.
- The DO is the only writer of its own truth, which preserves
  ADR 0003's authority model.

**Negative:**

- A new responsibility on the DO (alarm management) that survives
  across `version` schema bumps and DO refactors. Manageable; the
  alarm handler is small and isolated.
- DOs that go fully idle still pay the cost of one alarm fire per
  day. At our scale negligible; worth knowing.
- Bootstrap requires every entity DO to handle at least one push to
  schedule its first alarm. An entity created before this ADR but
  never touched again does not get swept. Acceptable: the
  synchronous emit ran when it was created, and there's nothing
  for the alarm to reconcile against if no mutations have happened.
- Retry backoff state lives in DO storage. One more thing to clear
  on schema migrations.

## Alternatives considered

- **(a) Cron worker over D1.** Rejected as the primary mechanism;
  noted as the right shape for orphan-row cleanup.
- **(b) Every-push opportunistic reconciliation (read D1, re-emit
  if drifted).** Rejected — doesn't address the idle-DO drift case.
  Could be added as a belt-and-suspenders without conflicting with
  the alarm design; not done at v1.
- **(c) Content-hash on each D1 row, compared on every emit.**
  Rejected — version is already a sufficient invariant. Add later
  if a non-version-bumping change channel ever exists.
- **(d) Always-upsert (no version guard).** Rejected — downgrade
  hazard.
- **(e) Always-upsert with `version = MAX(version, excluded.version)`
  on each column.** Rejected — fields don't move independently;
  guarding the entire row by version is correct and simpler.
- **(f) Push-time queue of failed emits, drained by a worker.**
  Rejected — adds a separate persistence surface (the queue) to
  reconcile a derived index, doubling the surfaces that can drift.
- **(g) Sub-hour alarm cadence.** Rejected for v1 — the synchronous
  emit handles freshness; the alarm is recovery, not freshness.
  Telemetry-driven revisit if the drift counter is high.

## Open questions

- **Alarm cadence (24h)** is a guess. Telemetry-driven revisit once
  the drift counter has real numbers behind it.
- **Drift counter surface.** Console logs for v1; a real metric
  sink when there's somewhere to send it.
- **Cross-D1 orphan sweep.** Deferred to its own follow-up; will
  most naturally hang off `scheduled` once the workspace DO lands
  and ADR 0008's hard-delete pipeline produces orphans to sweep.
- **Coordination with cascade-delete.** Resolved by ADR 0008:
  cascade is entity-level only (does not fan-out to items inside
  a List), and the cascade-archive bumps `version` monotonically
  on the entity row, so the alarm-driven emit invariant holds
  unchanged. The dispatcher refactor in ADR 0008 generalizes this
  ADR's single-event alarm into a multi-event handler; the
  reconciliation event is one entry in that dispatcher.

## References

- ADR 0001 — Entity metadata in D1 with DO mirror. The original
  shape this ADR's predecessor (ADR 0003) inverted.
- ADR 0003 — DO as authority with D1-derived index. Establishes the
  invariant the sweeper enforces.
- `workers/src/list/entity.ts` — `EmitEntitySnapshotToCatalog`.
- `workers/src/list/durable_object.ts` — `emitEntitySnapshot` and the
  push handler that triggers it.
- `workers/migrations/0004_workspace_entities.sql` — schema with the
  `version` column the guard reads.
