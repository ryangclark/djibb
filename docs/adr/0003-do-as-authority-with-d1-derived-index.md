# ADR 0003: DO as authority for entity metadata; D1 as derived read index

- **Status:** Accepted (supersedes ADR 0001)
- **Date:** 2026-04-29

## Context

ADR 0001 made D1 the authoritative store for entity-level fields (`name`, `workspace_id`, `authorization_rules`, `forked_from_id`, timestamps) and gave each Durable Object a local mirror to keep hot-path reads fast. It solved real problems — workspace catalog queries, auth resolution without DO cold-start, cascade delete — and explicitly accepted "two-write coordination on metadata" and "offline metadata edits are lost" as bounded costs.

In the weeks since, the cost has not stayed bounded. Every metadata feature touched runs into the same friction:

- **Rename a List** is naturally a Replicache mutation (uniform client API, optimistic update, queued offline) — but with D1 as authority it becomes a worker-side HTTP path, or a mutation with a worker pre-hook that re-validates everything the DO would validate, then writes D1, then forwards to the DO to keep its mirror consistent. Either shape duplicates work or duplicates trust.
- **Change `authorization_rules`**, **archive a List**, **set `description`** — same shape, same friction. Each one is another two-write, with its own failure-direction question (D1 first leaves the mirror stale; DO first leaves D1 stale; either way the auth resolver and the pull overlay disagree until reconciliation).
- **Mutation log** (a near-term goal) wants to be the per-list audit/replay record of every change. With ADR 0001, half the changes (body) live in the log and half (metadata) live in D1 history if anywhere — the log is no longer "everything that happened to this List."
- **Offline mode** is explicitly broken for metadata under 0001. The Moab packing scenario in `docs/use-cases.md` exercises offline element editing; it does *not* exercise offline rename. But "I added an item and renamed the list while on the plane" is the same gesture from the user's perspective, and 0001 makes the second half silently fail.

Each of these friction points individually fits 0001's "bounded cost" framing. Taken together, they describe a consistency model split across two stores with different guarantees, and a steady gravitational pull toward "fix it by making D1 more authoritative" — at the cost of the Replicache-first, mutation-log, offline-capable design the project is otherwise built on.

This ADR proposes inverting the authority direction while preserving 0001's functional wins.

## Decision

**The Durable Object is the single authority for every field of every entity it owns.** D1's `workspace_entities` table is preserved as a **derived read index**, populated by the DO whenever metadata changes. D1 is a denormalized cache for cross-entity queries; it is never written to outside that path.

Concretely:

- **Writes always go through Replicache mutations to the DO.** `renameList`, `setListAuthRules`, `archiveList`, etc. are ordinary mutations alongside `createListItem` and `setItemQuantity`. Same client API, same optimistic update, same offline queueing, same mutation log entry.
- **The DO emits to D1** as a side-effect of any mutation that touches an indexed field. The emit happens after the DO's own write commits, via a service binding or `env.D1.prepare(...)` call from the DO. If D1 is unavailable or the write fails, the DO retries on next mutation or on a periodic sweeper. D1 staleness never blocks a mutation.
- **Reads from D1 are advisory.** The workspace catalog query, the auth resolver's anonymous-read fast path, and any future cross-entity index all read D1 with the understanding that it may lag the DO by seconds. For auth specifically, a stale `default_role` in D1 is acceptable because (a) the DO re-checks on every mutation, and (b) the lag window is short and unidirectional toward the more-restrictive recent state.
- **Reconciliation is "ask the DO."** If D1 ever drifts visibly, the recovery path is to re-emit from the DO's current state. There is no manual two-store coordination protocol; the DO is the single source of truth and D1 is regenerable.
- **The pull overlay goes away.** Workers no longer overlay D1 fields onto the DO's pull response (commit `b0ac520`). The DO's own row carries every entity field, full stop. This removes one of the most subtle failure modes in 0001 — the moment between a metadata change and the next pull where what the user sees depends on which store the worker reads.

### Init flow under this model

1. Frontend generates the entity ID and queues `initList` as a Replicache mutation.
2. On reconnect, the push reaches the worker. The worker forwards to the DO without writing D1 first.
3. The DO's `initList` server mutator writes the full entity row to its own sql, including all entity-level fields. This is the authoritative write.
4. After commit, the DO emits an `INSERT INTO workspace_entities ...` to D1 as a derived-index update. Idempotent on entity ID. If it fails, the next mutation that touches metadata re-emits; a sweeper backstops.
5. The push succeeds as soon as step 3 commits. D1 catching up does not gate user-visible success.

### Auth resolution under this model

The auth resolver's anonymous-read fast path (`workers/src/list/fetch.ts`) reads `authorization_rules` from D1 to deny unauthorized requests without instantiating the DO. Under 0003 this path still works — D1 still has the field — but the field is now best-effort. To preserve the cold-start-free property:

- For reads (pull, page render): D1 lookup is sufficient. Stale-toward-restrictive is acceptable; stale-toward-permissive is the worst case and is bounded by the emit lag, which under normal operation is sub-second.
- For mutations: the DO is the policy enforcement point. The worker can fast-deny on D1 if the rule is clearly restrictive, but every mutation passes through the DO anyway, so the DO has the final say with its own (authoritative) `authorization_rules`.

### What the DO sql layout looks like

The `list_elements` row for the entity itself comes back. Init writes it. Every entity-level field lives there alongside the body fields. This restores the pre-0001 layout for the entity row; group and item rows are unchanged.

## Pros and cons against ADR 0001

### What 0003 wins (vs 0001)

- **Single consistency model.** Everything is a Replicache mutation. There is no second class of "metadata operations" with different semantics, different validation paths, and different failure modes.
- **Mutation log is complete.** Rename, archive, auth changes — all are entries in the per-list log. Replay reconstructs the full state of the entity, not "the body plus whatever D1 currently says."
- **Offline metadata edits work.** Renaming the list on the plane queues like any other mutation and replays on reconnect. Same gesture, same guarantees.
- **No two-write coordination.** The "D1 first or DO first" question dissolves. There is one writer (the DO) and one derived emit; emit failures are eventually consistent rather than corrupting.
- **Pull overlay disappears.** The DO's row is the answer. Fewer code paths, fewer subtle bugs.
- **Validation lives in one place.** The mutator's `argsSchema` and `requiredRole` are checked once, in the DO. No worker pre-hook duplicating intent.

### What 0001 wins (vs 0003)

- **Workspace catalog queries are guaranteed-fresh.** Under 0001, a List's name in `workspace_entities` is canonical the moment the rename succeeds. Under 0003, there is a brief lag window where the catalog and the DO disagree. For a sidebar or `/w/:slug` view this is rarely visible, but it is a real semantic change.
- **Cascade delete is one D1 statement.** 0001's "soft-delete every entity in workspace W in a single UPDATE" is genuinely elegant. 0003 either fans out to DOs (slower) or marks D1 first and lets DOs catch up on next access (works, but adds a "deleted in D1, not yet in DO" intermediate state that has to be handled at every read site).
- **Auth resolver is provably correct on the cold path.** Under 0001, the `authorization_rules` D1 reads is the latest. Under 0003 it is up to one emit-lag stale. This is fine for "reject anonymous read of a restricted list" (stale-toward-permissive only happens just after a permission *removal*, narrowly) but is a real weakening of the guarantee.
- **DO doesn't need a D1 binding.** Under 0001, only the worker holds the D1 binding; the DO is sandboxed from D1. Under 0003 the DO emits to D1 directly, which means the DO carries a D1 binding and can in principle read or write more than its own row. A discipline question, not a hard constraint, but worth naming.
- **Already implemented.** 0001 is the current shape. 0003 is a refactor — bounded, but real work — and any wins from 0003 are offset by the cost of getting there.

### Where the costs concentrate

The hard 0001 wins are all on the **read** side: catalog queries, auth fast path, cascade delete. The hard 0003 wins are all on the **write** side: uniform mutations, log completeness, offline, no two-write coordination.

0001 chose to pay write-side cost for read-side wins. The bet was that read paths would dominate (catalog views, auth checks per request) and write paths would be rare (rename is a once-a-month gesture). That bet is mostly correct in steady state.

The reason it's worth re-litigating is that **the protocol's identity lives on the write side**. djibb's distinguishing properties — Replicache-first, mutation-log replayable, offline-capable, remix-as-fork — are all write-side properties. 0001 trades the project's distinguishing identity for read-path performance that could be solved a different way. 0003 trades a small, bounded read-path lag for keeping the identity intact.

## Consequences

**Positive (if accepted):**

- Replicache becomes the uniform consistency model again. The mental load of "is this a body field or a metadata field" disappears from feature work.
- Mutation log is whole, which simplifies the eventual log-as-feature work substantially.
- Offline metadata edits work, restoring the airplane-rename gesture.
- The pull overlay machinery and the worker pre-hook machinery both disappear before they fully exist. Code deleted, not added.
- Adding a metadata field (e.g. `description`, `cover_image_id`) is the same effort as adding a body field — define a mutator, register it, build UI.

**Negative (if accepted):**

- Refactor cost: init flow inverts (DO writes, then emits to D1), pull overlay removed, mutators added for metadata, sweeper for D1 reconciliation. Bounded — current production surface is small — but real.
- Catalog queries become eventually-consistent. The lag window is small but is a contract change worth owning.
- Auth resolver's D1 fast path becomes a cache rather than a source of truth. The implications are narrow but should be tested explicitly under permission-revocation scenarios.
- DO gains a D1 binding. Discipline must enforce that the DO only writes its own derived row.
- Cascade delete on workspace becomes a fan-out (or a "mark D1, lazily mark DOs" hybrid). The single-statement elegance is lost.

## Alternatives considered

- **(a) Keep 0001 as-is.** Accept the friction; build per-mutator worker pre-hooks; treat metadata mutations as a second-class category. Rejected as the framing of this ADR — the friction is steady, not transient, and pulls the project away from its own distinguishing properties.
- **(b) Hybrid: Replicache mutations for metadata, but server mutator runs in the worker (writes D1) instead of the DO.** Keeps the client API uniform but splits the server-side mutator dispatcher across two locations. Mutation log entries land in D1 instead of the per-list DO log, fragmenting the audit trail. Rejected — the duplication smell from earlier in the design conversation reappears one layer deeper.
- **(c) Full rip of `workspace_entities` — no D1 index at all.** Catalog and auth queries fan out across DOs every time. Rejected for the same reason 0001 rejected its own (c): catalog rendering would require N DO instantiations per page load.
- **(d) DO-as-authority with synchronous D1 write inside the mutation.** The DO's mutator writes its sql and D1 in the same handler, both must succeed, fails the mutation if either does. Avoids the staleness window but reintroduces the gate-blocking D1 round-trip from the original 0001 alternative (c) it rejected for that exact reason. Rejected.

## Open questions

- **Cascade delete shape.** "Mark D1 first, DOs catch up lazily" is workable but needs a concrete protocol. Worth a sub-ADR or an extension to this one before implementation.
- **D1 reconciliation sweeper.** Frequency, trigger, and what to do if a DO is permanently unreachable (deleted? archived?). Not on the critical path for adoption but needed before this is the steady-state architecture.
- **Migration plan.** If accepted, ADR 0001's worker-orchestrated init and pull overlay get unwound. The current production surface is small (no real users) so the migration is mostly code removal rather than data migration, but the order of operations matters.

## Future evolution: event bus and external subscribers

The DO-emits-to-D1 pattern this ADR introduces is the first instance of a more general shape: **the DO is an event source, and external systems are projections.** The mutation log inside the DO is the journal; D1 is the first projection. There will be more — internal ones (notifications, audit export, search index) and eventually user-registered ones (webhooks as a protocol feature, where users subscribe their own systems to changes on their Lists).

The forward shape, when the second internal subscriber justifies the indirection:

- **Atomic boundary stays "state + log entry"** inside the DO. Subscribers fire *after* commit; if every subscriber fails forever, the DO is still correct. Catch-up is replay from a stored log cursor.
- **Cloudflare Queues as the delivery primitive.** DO commits, enqueues an event, returns. The DO's gate is unblocked at enqueue time. Per-subscriber retries, dead-letter, and rate limits live in the consumer.
- **One mechanism, two policies** for internal vs external. Internal subscribers run hot (low-latency, tight retry, in-process trust). External user-registered subscribers run cool (signed payloads, exponential backoff, delivery dashboard, per-subscriber pause). The DO doesn't distinguish; the dispatcher does.
- **Event shape: mutation envelope + a domain summary** (`item_created`, `list_renamed`, `item_checked`). The envelope keeps the audit trail honest; the summary lets subscribers ignore the mutator vocabulary and react to domain events.
- **External webhooks turn djibb into a platform.** "Ping my Discord when my grocery list is checked off," AI agents subscribed to list changes, Zapier-style integrations. This is a meaningful product surface and deserves its own ADR when committed to.

**This is recorded direction, not committed work.** The 0003 refactor uses a direct DO-to-D1 emit, no subscriber framework. The framework arrives when the second internal subscriber needs it, replacing one call with `bus.emit()`. External subscribers are a later, separately-scoped ADR. The intent of writing it here is to keep build decisions in the meantime aligned with where this is going — for example, designing the D1 emit's payload close enough to "an event" that promoting it to bus-style fan-out later is mechanical.

## References

- ADR 0001 — entity metadata in D1 with DO mirror (the decision this ADR re-litigates)
- ADR 0002 — djibb.com homepage Island depends on a workspace catalog query; under 0003 that query reads the derived D1 index, same as today
- `CONTEXT.md` — List, Template, mutation envelope semantics
- Design conversation 2026-04-29 — friction enumeration that prompted this re-litigation
