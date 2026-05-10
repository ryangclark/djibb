# Adding a mutator

Checklist for adding a new Replicache mutation. The pattern is well-worn
at this point — `renameList`, `archiveList`, `setDescription`,
`setListAuthRules` are all near-identical — but a few steps are easy to
miss.

## The pattern in three sentences

A mutation is a typed args object the client queues optimistically and
the server applies atomically against the DO sql. The client mutator
runs against a Replicache `WriteTransaction` for instant local feedback;
the server mutator runs inside the DO's push handler against
authoritative SQL. Both come from the same file and share an
`argsSchema` so the wire format can't drift between them.

See `workers/src/list/mutators/renameList.ts` for the canonical
template. Copy it, adjust, register, test.

## File layout

Each mutator is one file in `workers/src/list/mutators/`. Required
exports:

| Export | Type | Purpose |
| --- | --- | --- |
| `argsSchema` | `z.ZodType` | Body args (does **not** include envelope fields). |
| `Args` | inferred type | `z.infer<typeof argsSchema>`. |
| `name` | string literal | Wire name. Must match the file. |
| `requiredRole` | `readonly AuthorizationRole[]` | Gate. Use `EDIT_ROLES` or `OWNER_ROLES` from `_shared.ts`. |
| `server` | `ServerMutator<Args>` | Runs in the DO. Calls a narrow SQL helper with `ctx.nextVersion`. |
| `client` | `ClientMutator<Args>` | Runs against `WriteTransaction`. Reads existing entity, sets back with bumped version. |
| `inverse` | `(args, preState?) => { name, args } \| null` | Returns the inverse mutator and its args, or `null` if the action is intentionally not undoable. Constructive/archive mutators ignore `preState`; set-family mutators use it. **Required** by ADR 0005 — every mutator declares an inverse, even if it's a no-op (`null`). The runtime treats `null` as silent-skip. |
| `capturePreState` | `(tx, args) => Promise<object>` | **Set-family only.** Reads from the Replicache cache and returns *only* the fields the inverse will need. Co-locates read shape with write shape. Constructive and archive/restore mutators don't export this. Required for set-family mutators by ADR 0005. |

## Steps

1. **Create the mutator file.** Copy `renameList.ts` and adjust. Keep
   `server` thin — the SQL helper is where the actual write lives.

2. **Add a SQL helper** in `workers/src/list/sql.ts` if you need a new
   write shape. Existing pattern: take `{ entityId, ..., version }`,
   `UPDATE list_elements ... WHERE id = ? AND time_deleted IS NULL`,
   throw `NotFoundError` on `rowsWritten !== 1`. **`time_deleted = null`
   never matches anything** — use `IS NULL`.

3. **Register the mutator** in `workers/src/list/mutators/index.ts`:

   ```ts
   import * as myMutator from './myMutator';

   export const Mutations = {
       // ...
       [myMutator.name]: myMutator,
   } as const;
   ```

   The dispatch layer reads from this map. Forgetting this step gets
   you "unknown mutator" at runtime.

4. **If the mutator touches entity-level metadata** (`name`,
   `description`, `authorization_rules`, `time_deleted`, etc. — the
   fields projected to the D1 catalog), add the name to
   `ENTITY_METADATA_MUTATORS` in `workers/src/list/durable_object.ts`.
   This is what triggers the post-commit `emitEntitySnapshot` to D1.
   **Forgetting this is a silent bug** — the mutation succeeds, the
   DO row updates, but the catalog read index drifts until the next
   metadata write covers for it.

   Body mutators (touching items / groups / quantities — anything not
   indexed in D1) skip this step.

5. **Define the inverse.** Per ADR 0005, every mutator declares how undo
   reverses it. There is no parallel "inverse server surface" — every
   inverse is itself a forward mutator that lands the entity in a prior
   state. The `inverse` export is a small client-side utility that picks
   which forward + what args. Three categories — pick the one your mutator
   fits:

   - **Constructive** (creates new entities): inverse archives what was
     just created. `createListItem` → `archiveListItem({id})`. No
     pre-state needed; the id is in forward args. Don't export
     `capturePreState`.
   - **Archive/restore** (soft-delete or restore): inverse is the
     mirror. `archiveListItem` → `unarchiveListItem`,
     `archiveListItems` → `unarchiveListItems`, `archiveList` →
     `unarchiveList`. No pre-state needed. Don't export
     `capturePreState`.
   - **Set-family** (replaces field values): inverse is the same
     mutator with previous values. `renameList` → `renameList` with
     `prev_name`. **Export `capturePreState`** alongside `inverse`;
     return only the fields the inverse will need.

   If your mutator is **set-family umbrella** (writes multiple fields
   under one `fields` key — `setItemFields`, `setItemsAtomic`,
   `setGroupFields`, `setGroupsAtomic`), the canonical shape is:

   ```ts
   argsSchema = z.object({
     id: ...,
     fields: z.object({ ...all writable keys, all .optional() }).strict(),
     expected: z.object({ ...same shape }).strict().optional(),
   });
   ```

   `capturePreState` returns an object whose keys exactly match the
   keys present in `args.fields`. The inverse swaps `fields` ↔ `expected`
   and points at the same mutator name.

   For both narrow and umbrella set-family mutators, add the optional
   `expected` arg. When present, the server checks current state
   against each key in `expected` before applying; **any mismatch
   no-ops the entire mutation** (all-or-nothing per envelope).
   Forward calls don't supply `expected`; undo calls do. This is the
   CAS that makes defensive undo policy work — see ADR 0005
   §"Defensive conflict policy."

   If the inverse mutator doesn't exist yet (e.g. you're adding
   `archiveListItems` and there's no `unarchiveListItems`), build the
   inverse mutator alongside it. Inverses are full mutators with their
   own `argsSchema`, `requiredRole`, server, and client. The pattern
   is symmetric — `unarchiveListItem`'s `inverse` returns
   `archiveListItem`, so undo-of-undo is just redo with no special
   tracking.

   If your mutator is intentionally not undoable, export
   `inverse: () => null`. The runtime silently skips pushing — the
   action just doesn't enter the user's undo history. Don't reach for
   this without a real reason; the type-system requirement to export
   `inverse` is meant to force the design-time question "what does
   undoing this look like?"

   **Mutators that warrant extra friction.** If your mutator crosses
   an authority threshold (auth-rules change) or a structural
   threshold (list creation/deletion), flag it for the two-step
   confirm-toast UX. Add the mutator's wire `name` to the friction
   list the client consults when rendering the undo toast. ADR 0005
   §"Auth-rules and init undos require extra friction" has the full
   list.

6. **Write a test.** Pattern lives in `workers/test/`. The shape:
   - Init the entity via a `handlePush` of `initList`.
   - Push your mutator via `handlePush`.
   - Assert against the DO sql via `runInDurableObject`.
   - Optionally assert via `handlePull` that the patch carries the
     change.

   See `workers/test/entityMetadata.test.ts` for a compact example
   covering three mutators in one file.

## Decisions you have to make

### Role gate: `EDIT_ROLES` vs `OWNER_ROLES`

- **`EDIT_ROLES`** — admin, checker, editor, owner, ownerless. Use for
  most mutators. Anything that mutates list state (rename, archive,
  set description, create/edit items) fits here.
- **`OWNER_ROLES`** — admin, owner only. Use for mutators that change
  *who else can access the entity*. Currently just `setListAuthRules`.
  The exclusion of `ownerless` is by design: a passing stranger can't
  lock down an anonymous-edit list. The path to claim ownership of an
  ownerless list goes through a separate (yet-unbuilt) flow.

If you find yourself wanting a third tier, the role enum lives in
`workers/src/auth/rules.ts`. Resist adding mid-tier gates without a
clear use case.

### Metadata vs body

- **Metadata mutator** — touches `name`, `description`,
  `authorization_rules`, `forked_from_id`, `workspace_id`, or
  `time_deleted` on the entity row. Goes in `ENTITY_METADATA_MUTATORS`,
  triggers a D1 snapshot emit.
- **Body mutator** — touches items, groups, quantities, or anything
  else under the entity. Skips the D1 emit.

If you're updating multiple fields on the entity row, it's still one
metadata mutator (one snapshot emit covers all changes).

### Whole-replace vs field-level delta

`setListAuthRules` does a whole-replace of the rules object. That's the
simpler primitive — field-level deltas (e.g. "add this account as
editor") can be added later as separate mutators if the UI needs them.
Default to whole-replace; let the UI's needs pull you toward deltas.

## Wire envelope (you mostly don't have to think about this)

Replicache's wire format crams `accountId` and `timestamp_client` into
each mutation's `args`. Both sides handle this transparently:

- **Server**: `parseMutationEnvelope` splits envelope off body before
  dispatch. Your `server` function receives body args plus an envelope
  `ctx` with `accountId`, `timestamp_client`, `sql`, `role`,
  `nextVersion`.
- **Client**: `wrapMutators` in `pages/src/lib/replicache/index.svelte.js`
  injects envelope fields per call. Components pass body args only.
  Your `client` function receives `(tx, body, ctx)` where `ctx` carries
  `accountId` / `timestamp_client`.

Define your `argsSchema` as **body fields only**. Don't include
`accountId` or `timestamp_client` — they're injected at the transport
boundary.

## Version bump model

The version field on the entity row is what cookie-based pull diffing
keys off. Both sides bump it:

- **Server**: use `ctx.nextVersion` in your SQL helper. The push
  handler computes `nextVersion = listVersion + 1` and threads it in.
- **Client**: increment the entity's existing version locally
  (`(entity.version ?? 0) + 1`).

If you forget the version bump, the next pull won't propagate the
change.

## Worked example

`workers/src/list/mutators/renameList.ts` is the canonical template.
26 lines of server mutator + 22 lines of client mutator. Read it, copy
it, adjust two things (argsSchema and the SQL helper), and you're 80%
done.

## Why this shape — see ADR 0003

The DO is authoritative for every field of every entity it owns. D1 is
a derived read index, populated post-commit by the DO. Every metadata
gesture is a mutation in this same shape — there is no second class of
"metadata operations" with different semantics.

Full reasoning: `docs/adr/0003-do-as-authority-with-d1-derived-index.md`.
