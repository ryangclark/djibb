# ADR 0001: Entity metadata in D1, elements in DO with metadata mirror

- **Status:** Accepted
- **Date:** 2026-04-26

## Context

djibb stores Lists and Templates. Per `CONTEXT.md`, both share the same Durable Object machinery (one `DjibbList` DO class, one binding, distinguished by `type: 'list' | 'template'` on the entity row).

Until this decision, the entity-level row — `id`, `name`, `workspace_id`, `type`, `authorization_rules`, `forked_from_id`, `time_*` — lived inside its per-entity Durable Object's `list_elements` table, alongside the entity's groups and items. There was no D1-side index of entities by workspace; `workspace_id` lived only in each DO's `kv`.

This shape created concrete friction:

- Listing "all Lists in workspace W" required fanning out to every DO to read its `workspace_id`. Not viable for the workspace home page (`/w/:slug`).
- Authorization resolution in `workers/src/list/fetch.ts` had to instantiate the DO on every request just to read `authorization_rules` — including for unauthenticated visitors to public-default-role Templates.
- Workspace cascade deletes (`docs/workspaces.md`) and any future server-authored operation over a workspace's entities had no efficient path; everything had to round-trip through individual DOs.

## Decision

Split entity storage:

- **Authoritative source:** a new D1 table `workspace_entities`:

  | column                | notes                                                       |
  |-----------------------|-------------------------------------------------------------|
  | `id`                  | TEXT PK, prefixed nanoid (`l/...` or `t/...`)               |
  | `workspace_id`        | TEXT NOT NULL → `workspaces(id)`                            |
  | `type`                | TEXT NOT NULL — `list` \| `template`                        |
  | `name`                | TEXT                                                        |
  | `description`         | TEXT NULL                                                   |
  | `forked_from_id`      | TEXT NULL — points at any entity (List or Template) by ID   |
  | `authorization_rules` | TEXT NOT NULL — JSON, the `AuthorizationRules` shape         |
  | `time_created`        | INTEGER NOT NULL                                            |
  | `time_updated`        | INTEGER NOT NULL                                            |
  | `time_deleted`        | INTEGER NULL (soft delete)                                  |
  | `version`             | INTEGER NOT NULL — bumped on metadata writes                |

  Indexed on `(workspace_id, type, time_deleted)` for catalog queries.

- **DO mirror:** every Durable Object stores its own copy of its entity-level metadata in its `kv` table. The DO never queries D1 on its hot path; reads are local.

- **Element store stays in the DO:** `ListGroup`s and `ListItem`s continue to live in the DO's `list_elements` table and sync via Replicache. The DO's `list_elements` table no longer holds the "list itself" row — that row's home is now D1.

### Reconciliation protocol — offline entity creation

Offline element editing is a stated requirement (`docs/use-cases.md` — Moab packing scenario). Offline entity *creation* must also continue to work:

1. Frontend generates the entity ID and queues `initList` (or `initTemplate`) as a Replicache mutation against the new entity's (yet-uninstantiated) DO, then proceeds to queue element mutations as normal — all offline-capable.
2. On reconnect, the first push reaches the worker. The worker orchestrates init, atomically from the client's perspective:
   a. Worker `INSERT INTO workspace_entities ...` (D1). Idempotent on entity ID.
   b. Worker forwards the push to the DO with the resolved metadata + caller's role attached to the request envelope.
   c. DO's `handleInitList` writes the DO's `kv` mirror from the envelope, then processes any subsequent queued element mutations normally.
3. Push succeeds only if both D1 insert and DO mirror write succeed; on partial failure the client retries the queued push.

**Why worker-orchestrated rather than DO-orchestrated:** the literal "DO mutator RPCs back to the worker" pattern would require the DO's env to carry a service binding to its own worker (or `fetch()` its own URL), inverting the usual call direction. Hosting init in the worker keeps D1 work where D1 bindings naturally live and matches the policy-decision-point / policy-enforcement-point split adopted for the auth resolver. The trade-off is mild: the DO is no longer the sole authority on its own creation. The atomicity invariant is preserved one layer up.

Failure modes for offline-created entities:

- **D1 insert fails** (workspace deleted while client was offline, account lost access): the mutator rejects. Replicache surfaces the error; the client shows a recoverable failure (e.g. "workspace no longer accessible — pick another"). Local data is not lost.
- **Concurrent same-ID create from another client:** D1 PK on `id` rejects the duplicate. Idempotency means a retry of an already-inserted row is a no-op.

### Metadata mutation protocol — rename, move, change auth rules

- Server-authoritative HTTP only. No Replicache mutation path.
- Worker writes D1 first; on success, RPCs the DO to update its `kv` mirror.
- DO mirror is best-effort and recoverable from D1 if drift is ever observed.

**Loss accepted:** rename, workspace move, and `authorization_rules` change all require network. The 90% offline use case (element editing on synced entities) is preserved.

### Cascade delete

Workspace soft-delete writes `time_deleted` on every `workspace_entities` row in one D1 update. DO mirrors are updated via the same metadata-sync RPC where possible; even if a DO is never re-touched, the entity is absent from any catalog query and its `authorization_rules` is unreachable through the auth resolver's D1 path, blocking access.

## Consequences

**Positive:**

- **Catalog queries are O(1) D1.** Workspace home (`/w/:slug`) renders Lists and Templates from a single `SELECT` with no DO fan-out.
- **Auth resolver is DO-cold-start-free for anonymous reads.** Public Template viewers hit D1 directly. Active sessions read the DO's local mirror, also a single hop.
- **List vs Template polymorphism is one column.** `type='template'` in the catalog query is the entire distinction at the data layer.
- **Cascade-on-workspace-delete is one D1 statement** instead of an N-DO fan-out.
- **Server-authored operations over a workspace's catalog become straightforward** — bulk move, audit, search, future global Template index.

**Negative:**

- **Two-write coordination on metadata changes.** D1 + DO mirror must stay in sync. D1 is authoritative; DO mirror drift is reconcilable.
- **Offline metadata edits are lost.** Renames, workspace moves, authorization changes require network. Element editing offline is unchanged.
- **`initList` mutator now performs cross-binding RPC.** New failure modes (D1 unavailable, insert rejected). Mutator must be idempotent on retries.
- **Migration cost.** Existing entity rows in DO `list_elements` need a one-time backfill into D1 `workspace_entities` on rollout. Working tree is pre-production, so the cost is bounded.

## Alternatives considered

- **(a) Parallel-write D1 catalog table, DO remains authoritative.** Worker writes both DO and D1 on every metadata mutation. Solves catalog fan-out but doesn't free the auth resolver from DO instantiation, and `authorization_rules` lives twice with the DO copy authoritative — confusing seam. Rejected: doesn't move authority, just adds bookkeeping.
- **(b) Keep entity metadata in the DO; add a skinny D1 index `(entity_id, workspace_id, type)`.** Catalog enumeration is fast, but per-entity metadata still requires DO fan-out for names/timestamps and the auth resolver still pays DO cold-start. A half-measure that would be revisited. Rejected.
- **(c) Full split — D1 authoritative, no DO mirror.** The cleanest separation, but the auth resolver and any in-DO logic wanting "what workspace am I in?" or "what are my auth rules?" would make a synchronous D1 call from inside the DO on every push/pull. Rejected: that's a per-mutation D1 hop the mirror eliminates for the cost of one write on metadata change.

The chosen design (this ADR — call it "c-lite" in the architecture review notes) preserves offline element editing, keeps auth resolution fast on the hot path, and gives us a real workspace catalog. The costs (two-write coordination on metadata, no offline metadata edit) are bounded and acceptable.

## References

- `CONTEXT.md` — List, Template, Workspace, Account, `forked_from_id`
- `docs/use-cases.md` — offline editing in Moab as a load-bearing scenario
- `docs/workspaces.md` — workspace cascade delete semantics
- Architecture review session 2026-04-26 — candidate #2 (List-like seam) grilling, decisions G1–G5
