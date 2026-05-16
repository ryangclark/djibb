# Plan: in-app event log

**Status:** Not started. Captured here so it doesn't get lost.

## Why

Cloudflare's free-tier observability is shallow — Workers logs are
ephemeral, DO logs even more so, and there's no way to filter "show me
every emit failure on a Tuesday" without a paid product or shipping logs
out to a third party. We already write a `mutation_log` table for
Replicache audit purposes (ADR 0003). The natural extension is a sibling
`events` table that captures the things we'd otherwise lose into stderr:

- D1 emit failures (the case ADR 0007's alarm now catches but only
  logs to `console.error`).
- Auth denials that the middleware would otherwise silently 403.
- Reconcile-alarm drift counter ticks (ADR 0007 "Open questions" —
  needs a real metric sink eventually).
- Cascade-delete batch outcomes once ADR 0008 lands.

## Sketch

D1 table, one row per event:

```sql
CREATE TABLE events (
    id TEXT NOT NULL PRIMARY KEY,         -- ulid or similar
    event_name TEXT NOT NULL,             -- e.g. 'd1_emit_failed'
    severity TEXT NOT NULL,               -- 'info' | 'warn' | 'error'
    entity_id TEXT,                       -- optional FK to workspace_entities
    account_id TEXT,                      -- optional FK to accounts
    event_data TEXT NOT NULL,             -- JSON blob, schema per event_name
    time_created INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_events__name_time ON events(event_name, time_created);
CREATE INDEX idx_events__entity ON events(entity_id, time_created);
```

A small `recordEvent(d1, { name, severity, ... })` helper. A dashboard
route at `/admin/events` that queries the table with filters; gated to
internal-only roles.

## Open questions

- **Retention.** D1 isn't free past a row count. A `time_created < now -
  30d` cleanup in the same `scheduled` worker that ends up doing the
  orphan-sweep (ADR 0007 open question) seems right.
- **Event-bus relationship.** ADR 0003 sketches a future event bus
  fan-out (DO → many subscribers). If/when that lands, `events` becomes
  one subscriber on the bus — not a replacement for it. The two can be
  built independently; the event log is useful well before the bus.
- **Sampling.** A noisy event class shouldn't be able to flood the
  table. Per-event sampling rates configurable at the call site.

## Not in this plan

- Anything user-facing. The `events` table is for operators.
- Aggregation / charts. The dashboard at v1 is a sortable, filterable
  table.
- Cross-environment shipping (Logflare, Axiom, etc). If the dashboard
  proves useful and we want longer retention, that's a future call.
