# ADR 0008: Cascade delete via Workspace-DO alarm dispatcher

- **Status:** Accepted; implemented (shipped with the Workspace-as-`DjibbList` work in ADR 0011 §Step 10 — cascade dispatcher, Trash UI, and "Start Fresh"; see `workers/src/list/mutators/cascadeArchiveList.ts`, `cascadeRestoreList.ts`, `startFresh.ts`)
- **Date:** 2026-05-16
- **Layer:** server-cf

## Context

`archiveList` today soft-deletes only the entity row on the List's
DO. Items and groups under an archived List stay live in DO sql with
`time_deleted = null`; the UI hides them because their parent is
gone, but they're still present in storage. This works as long as
the only level that needs a "delete" verb is the List itself.

Three new pressures force a more complete model:

1. **Workspace deletion is undefined.** The Workspace DO is still a
   stub. When it lands and a user clicks "Delete Workspace," there
   is no story for the 47 Lists owned through it. ADR 0007 even
   names this as the blocker for cross-D1 orphan sweep.
2. **Storage hygiene has no ceiling.** Soft-deleted entities live
   forever today. The DO is cheap, but the D1 `workspace_entities`
   index grows monotonically with deletes. No mechanism reclaims
   that space.
3. **"I truly want this gone" has no surface.** Users who genuinely
   want their data deleted (privacy reasons, account cleanup,
   workspace deprovisioning) need a path that ends in hard-delete,
   not perpetual soft-delete.

A single unified design addresses all three: **soft-delete is the
user-facing verb at every level; a backend sweeper hard-deletes
30 days later.** This ADR settles the cascade shape for the
Workspace → (Lists, Templates) parent–child relationship — the only
cascade boundary in the system today.

## Decision

### Scope: entities only, cascade at the DO boundary

The cascade is **Workspace → Lists/Templates**. Sub-elements (items,
groups) inside a List do **not** get their own 30-day clock — they
ride along with their parent List's DO. When a List hard-deletes,
its entire DO storage (every item and group, the mutation log, the
alarms) goes with it in a single `ctx.storage.deleteAll()`.

Rationale: the DO is the natural unit of cascade. Items archived
*within* a live List stay reversible-forever, which matches how
users think about checkbox state ("I unchecked that, never mind").
Adding per-item expiry would add bookkeeping for a hygiene win that
doesn't exist (a List with 50k archived items is a user-shape
problem, not a storage problem).

### Cascade fan-out: each child gets its own `time_deleted`

When a Workspace is deleted, every List and Template it owns is
individually soft-deleted via the normal `archiveList` /
`archiveTemplate` mutator path. Each child writes its own
`time_deleted` to its DO sql and to `workspace_entities`.

We **do not** add a "hidden by parent" predicate to read paths
(checking `workspace.time_deleted` when reading a List). Every read
path stays `WHERE time_deleted IS NULL` on the child's own row.
This was a real fork — see *What hidden-by-parent would have won*
— and the cost of that predicate spreading through auth checks,
catalog queries, and pull filters outweighed any savings. The
client handles UI invisibility (a deleted Workspace doesn't render
in the switcher, so the user has no entry point to its Lists);
direct-URL access to a List in a mid-sweep Workspace continues to
work until the cascade reaches that List, which is correct ("the
link was working a second ago; now it isn't").

### Trigger: Workspace DO alarm dispatcher, async batched fan-out

`deleteWorkspace` returns immediately. The Workspace DO sets its own
`time_deleted`, sets `harddelete:at = T + 30d`, sets
`cascade:cursor = 0`, and schedules an immediate alarm. The alarm
handler reads the catalog for the next batch of N=10 child entities
by `workspace_id`, fans out cascade-archive mutations to those
List/Template DOs (see *Cascade-archive invocation*), advances the
cursor, and reschedules itself either for the next batch (immediate)
or, when the cursor is drained, for `harddelete:at` (30d out).

No cap on workspace size. A 500-List workspace takes a minute or so
to fully cascade in the background; the user's click returns
instantly regardless.

### Cascade-archive invocation: synthetic-client push at the `system` role

The Workspace DO invokes cascade-archives by calling each target
DO's existing `handlePush` entry point with `authorizedRole:
'system'`. The push payload uses the standard Replicache mutation
envelope. The clientID is synthetic and encodes the deletion epoch:

    cascade:w/<id>:<deletionTimestampMs>

Encoding the deletion timestamp means each cascade campaign is a
fresh synthetic client with a fresh `mutationID` counter, so
delete → restore → delete cycles never reuse a clientID and the
Workspace DO doesn't have to persist mutationID counters across
campaigns.

The `'system'` role (ADR 0011 §Step 10a.3) carries the auth
semantics that earlier drafts of this ADR proposed as a side-
channel `{system: true}` flag. There is no flag. `'system'` is a
real `AuthorizationRole` value alongside `owner`, `admin`, etc.;
cascade mutators gate on `requiredRole: SYSTEM_ROLES` and refuse
any other caller. `'system'` is structurally unreachable from any
HTTP-session resolution path (it is omitted from `AccountRoleEnum`,
`DefaultRoleEnum`, and the explicit-grant schema), so only direct
DO-stub-to-DO-stub calls can pass it. The HTTP boundary
additionally refuses to forward a `'system'` role as a
belt-and-suspenders gate (see `workers/src/list/fetch.ts`).

The args carry `cascade_source: w/<id>`. The mutator persists this
onto the child's entity row (and into the emitted catalog
snapshot), making "what was archived by which workspace deletion"
a single SQL predicate on the catalog: `WHERE cascade_source = ?`.

The mutation log entry on each child DO is uniform with client-
pushed entries — same envelope shape — distinguishable only by the
`cascade:` clientID prefix.

### Restore: inverse fan-out via the same cursor machinery

`restoreWorkspace` clears the Workspace's `time_deleted`, clears
`harddelete:at`, clears `cascade:cursor`, sets
`cascade-restore:cursor = 0`, and schedules an immediate alarm.
The alarm handler reads
`WHERE cascade_source = w/<id> AND time_deleted IS NOT NULL` for
the next batch and fans out `unarchiveList` / `unarchiveTemplate`
mutations.

Mid-sweep restore (user clicks Delete then Restore within seconds)
is handled by the state-driven alarm: any pending cascade-archive
alarm that fires after the restore reads the current Workspace
state, sees `time_deleted` is null, aborts the archive cursor, and
enters restore mode for whatever already got archived.

A list manually archived *before* the workspace deletion has
`cascade_source` null, so the restore predicate doesn't touch it —
the user's prior intent is preserved.

### Hard-delete: per-DO self-destruct via the alarm dispatcher

Cloudflare DOs have one alarm slot per DO. The hard-delete clock is
one event the dispatcher tracks via storage keys; the existing
ADR 0007 reconciliation cadence is another. The alarm handler
reads all pending event timestamps, runs handlers for any whose
time has come, and sets the next alarm to the earliest remaining.

Concretely on a child List DO:

- On cascade-archive, the mutator sets `harddelete:at = now + 30d`
  and reschedules the alarm if that's now the earliest pending
  event.
- On unarchive, the mutator clears `harddelete:at` and reschedules.
- When the alarm fires and `harddelete:at <= now`, the handler
  verifies the entity is still soft-deleted (didn't get restored
  during a network blip), then runs:
  - `ctx.storage.deleteAll()` — DO storage gone
  - `DELETE FROM workspace_entities WHERE id = ?` on D1
  - No further alarm scheduling — the DO has nothing left to do

The Workspace DO has the same machinery for its own
`harddelete:at`. By the time the Workspace's 30d clock fires, all
of its children have either hard-deleted or been restored along
with the Workspace.

### Friction tier and UX: modal confirm, no Cmd+Z, Trash UI for restore

Per ADR 0005's friction-tier model, `deleteWorkspace` is the
highest-friction operation in the system. It is **not** Cmd+Z-
undoable; the operation goes through an explicit modal that
surfaces the affected entity count ("This will archive 47 Lists
and 12 Templates"). Restoration happens through a Trash UI within
the 30-day window — a separate read-surface that lists
`time_deleted IS NOT NULL` entities owned by the account and
exposes per-entity Restore actions, including a Restore Workspace
action that triggers the cascade-restore.

The Trash UI is a prerequisite for shipping ADR 0008; without it,
the 30-day window is unreachable from the product surface.

### Personal Workspace: "Start Fresh," not Delete

Personal Workspaces (`is_personal: true`) cannot use the "Delete
Workspace" verb — same backend operation, different user-facing
verb and copy. The personal-workspace affordance is "Start Fresh":
cascade-archive every entity in the current personal Workspace
through the standard pipeline, *and* atomically spawn a new
personal Workspace and update the Account's pointer. The user
lands on a fresh empty Island; the old contents sit in Trash with
their 30-day clocks running.

This preserves the invariant that every Account has exactly one
current personal Workspace (no null window). It also actually
*uses* the cascade machinery for a verb users will reach for — "I
want a clean slate" is a real desire that no other mechanism
serves cleanly.

**Restoring a previously-personal Workspace from Trash, when a
fresher personal Workspace already exists**, restores it as a
regular (non-personal) Workspace. The user's current personal
Workspace is untouched; the restored one becomes a side-workspace
they can rename, migrate lists from, or just keep around.

### Templates cascade identically; `forked_from_id` becomes a read-time concern

Templates are top-level entities (same DO class as Lists), cascade
the same way as Lists when their owning Workspace is deleted, run
their own 30d clock, and hard-delete the same way.

`forked_from_id` pointers from Lists (or other Templates) into a
Template that gets hard-deleted become dangling. This is acceptable
because forking is *content-copy*, not reference-linking — the
forked entity owns its content independently and loses nothing but
the lineage breadcrumb. Read paths handle the missing source
gracefully ("Forked from a Template that has been deleted" or just
omit the affordance); the data itself is intact.

Workspaces with deeply-forked Templates are not special-cased.
Blocking the deletion of a Workspace because some other account has
forked one of its Templates would create a trap the user can't
escape (especially for `default_role: editor` Templates forked by
strangers). The dangling-reference path is the right answer.

## Pros and cons against alternatives

### What "hidden by parent" would have won (vs per-child cascade)

- **Cheaper write side.** Workspace deletion is O(1) — flip one row.
  No N-mutation fan-out across N target DOs.
- **Trivially atomic.** Either the Workspace is deleted or it isn't;
  no mid-sweep window where some children are archived and others
  aren't.

Rejected because the cost lands on every read path. Auth checks,
catalog queries, pull filters, and the Island map would all need a
compound predicate (`child.time_deleted IS NULL AND parent.time_deleted IS NULL`)
that follows the parent chain. That cost is paid forever, on every
read, even for entities whose parents have never been deleted. The
per-child cascade keeps every read simple (`WHERE time_deleted IS NULL`)
and pays the cost only at deletion time, in the background, on a
flow that the user has already accepted will take "some time."

The mid-sweep window we end up with (Workspace marked deleted but
some children not yet archived) is real but invisible from any
normal entry point: the client has already removed the Workspace
from its UI when it received the delete acknowledgment, and direct-
link access to a not-yet-archived child during the window is
arguably correct.

### What synchronous fan-out with a size cap would have won

- **Simpler code path.** One mutator does the whole cascade
  synchronously; no alarm dispatcher, no cursor, no batching.
- **Honest about scale limits.** A 500-List workspace is refused at
  delete time with a clear message, rather than silently taking a
  minute to drain.

Rejected because Cloudflare DOs serialize handlers, so even a 50-
List synchronous cascade blocks the user's click for ~10–20 seconds.
A cap (say, "refuse above 50 lists") doesn't help: a user with 47
Lists waits 15s; a user with 50 gets a "go archive some first"
error that's frustrating because they're trying to delete the
whole thing anyway. The async dispatcher gives the same UX at any
scale: instant return, background drain, recoverable for 30 days.

### What a centralized cron sweeper would have won (vs per-DO alarm)

- **Single observability surface.** All cascade and hard-delete
  activity in one worker handler instead of distributed across DOs.
- **No bootstrap concern.** Cron runs on every fire regardless of
  DO state.

Rejected because it inverts ADR 0003's authority model: a cron over
D1 would be driving DO destruction from the catalog, making D1
authoritative over DO lifecycle. The per-DO alarm dispatcher
preserves "DO is authoritative over its own state and lifecycle."
The ADR 0007 reconciliation sweeper uses the same per-DO alarm
shape; this ADR extends rather than introduces a new mechanism.

A cross-D1 orphan sweep (a `scheduled` worker that finds D1 rows
for DOs that no longer exist) is the natural complementary shape
and is deferred to its own follow-up, exactly as ADR 0007 already
deferred it.

### What a unified envelope union would have won (vs synthetic-client push)

- **Honest schema.** Tagged-union log entries explicitly distinguish
  client-originated from system-originated mutations, with richer
  per-category metadata fields.

Rejected because the discriminator was already implicit in the
clientID prefix (`cascade:` vs `c_`). Every concrete piece of
metadata the union envelope would have carried (cascade source,
originating user, triggering mutation) is either already in
`args.cascade_source` or recoverable via log lineage. The union
type was solving a problem already solved elsewhere.

### What letting the original user's clientID stamp cascade mutations would have won

- **Attribution stays human.** Every cascade-archive in the log is
  literally signed by the user who clicked Delete.

Rejected because the original user's tab tracks its own mutationID
counter. Cascades would have to invent mutationIDs on the user's
behalf, polluting that namespace. ADR 0006's outcome channel routes
by (clientID, mutationID); cascades stamped with a real clientID
would emit phantom outcomes the user's tab has no pending entry to
resolve. Synthetic clientIDs sidestep both problems and the
attribution is still recoverable via log lineage.

### What letting the personal Workspace be flatly undeletable would have won

- **Simplest possible rule.** "Personal Workspace cannot be deleted,
  full stop." No special verb, no Fresh Start path.

Rejected — see *Personal Workspace: "Start Fresh,"* above. There's
a genuine user desire ("I want a clean slate") that this rule
refuses to serve, and the cascade machinery is already capable of
serving it without any new primitive. "Cannot" is the wrong answer
when "yes, here's the verb" costs nothing more.

## Consequences

**Positive:**

- Workspace deletion has well-defined semantics across the entire
  parent–child boundary, including async fan-out, restore, hard-
  delete, and personal-Workspace edge cases.
- The 30-day safety window gives every destructive operation in
  the product a reversible window without compromising the
  eventual hard-delete path.
- Storage hygiene gets a ceiling: soft-deleted entities don't
  accumulate forever.
- `cascade_source` becomes a queryable lineage field on the
  catalog, unlocking the "navigate to a list in a deleted
  workspace" affordance ("This list was archived 6 days ago when
  workspace X was deleted — restore the workspace to get it
  back, or just restore this list").
- The alarm dispatcher pattern generalizes the ADR 0007
  reconciliation alarm into a single mechanism that handles
  multiple per-DO scheduled events. Future scheduled DO work
  (e.g. retention policies, scheduled exports) drops in.

**Negative:**

- Significant new surface on the Workspace DO: alarm dispatcher,
  cursor state, fan-out batch logic, synthetic-client minting.
  Most of this is just "Workspace DO" work that has to happen
  anyway; the cascade-specific portion is small.
- The Trash UI is now a hard prerequisite. Without it, soft-
  deletion is unreachable from the product surface.
- Log envelope has a third de-facto category (system-originated
  mutations via `cascade:` clientID prefix) that log readers must
  know to handle. Discriminator is conventional, not schematic.
- Mid-sweep window is observable via direct URLs. Acceptable per
  the design rationale above, but worth knowing.
- Hard-delete is genuinely irreversible after 30 days. UX copy at
  the delete-time modal must be unambiguous about this.

## Implementation sequencing

Deferred. This ADR captures the design; implementation lands
alongside the Workspace DO build proper. Speculative prerequisite
work (adding the `cascade_source` column, refactoring DjibbList's
alarm into a multi-event dispatcher, adding `system: true` to
`_handlePush`) is **not** done now — without a concrete caller,
those changes can't be validated end-to-end, and they'd drift
against surrounding code by the time the Workspace DO work begins.

When that work starts, ADR 0008 is the spec. The expected order:

1. Workspace DO scaffolding: entity row, push handler,
   `initWorkspace` / `renameWorkspace` / etc.
2. Catalog column: `cascade_source` on `workspace_entities` and
   `list_elements`. Migration + plumb through `EntitySnapshot`.
3. Alarm dispatcher refactor on `DjibbList`: storage-key-driven
   multi-event handler, generalizing the ADR 0007 reconcile
   alarm.
4. `_handlePush({system: true})` bypass path.
5. `deleteWorkspace` / `restoreWorkspace` mutators + Workspace
   DO alarm dispatcher with cascade-archive / cascade-restore
   modes.
6. Hard-delete event on the dispatcher (`harddelete:at`), both
   on child DOs (cascade-driven) and on the Workspace DO itself.
7. Trash UI: catalog read filtered by `time_deleted IS NOT NULL`
   and `account_owns(...)`; per-entity Restore actions; Restore
   Workspace fan-out trigger.
8. Personal-Workspace "Start Fresh" verb wiring (same backend,
   different UI surface + atomic personal-Workspace re-spawn).

Each step is independently testable; step 5 is the first one that
produces a user-visible cascade.

## Open questions

- **Trash UI shape.** The ADR commits to its existence as a
  prerequisite but not to its design (per-account vs per-
  workspace, sort order, filter axes, undo history within
  Trash). Settled when implementation starts.
- **Batch size N for cascade fan-out.** N=10 is a starting guess.
  Calibrate against DO RPC latency once measurable.
- **Account deletion** (a user closing their djibb account
  entirely) is a parent operation above Workspace deletion and is
  out of scope for this ADR. It will need to bypass the
  personal-Workspace "cannot be deleted as a Workspace" constraint
  because it's the parent verb. The `is_personal` flag is the
  hook.
- **Cross-D1 orphan sweep**, deferred by ADR 0007, can now be
  designed against this ADR's deletion model: an orphan is a D1
  row whose DO has been hard-deleted (or never existed). A
  `scheduled` worker that walks `workspace_entities` for rows
  with no corresponding live DO is the natural shape.
- **Retention overrides.** No per-Workspace retention policy in
  v1; 30 days is universal. A team admin who wants longer or
  shorter retention is a future feature, easy to bolt on as a
  per-Workspace column read by the alarm handler.

## References

- ADR 0003 — DO as authority with D1-derived index. Constrains the
  cascade implementation to keep the DO authoritative.
- ADR 0005 — Undo and inverse mutators. The cascade-archive and
  cascade-restore are inverses; the modal-confirm friction tier
  extends ADR 0005's tier model.
- ADR 0006 — ClientID-tagged websockets for outcome routing. The
  `cascade:` clientID prefix is what keeps cascade mutations from
  polluting this routing.
- ADR 0007 — D1 reconciliation sweeper. This ADR extends the same
  per-DO alarm pattern; the dispatcher refactor unifies them.
- `CONTEXT.md` — Workspace, List, Template definitions, including
  the "Start Fresh" verb and `is_personal` flag.
- `workers/src/list/durable_object.ts` — current alarm handler that
  becomes the dispatcher.
- `workers/src/list/mutators/archiveList.ts` — the mutator that
  gains a `cascade_source` arg.
- `workers/src/list/entity.ts` — `EntitySnapshot`,
  `EmitEntitySnapshotToCatalog`; gains a `cascade_source` field.
