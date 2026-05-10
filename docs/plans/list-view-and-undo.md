# Implementation plan: list view (ADR 0004) + undo (ADR 0005)

- **Status:** Drafted, pending B.1 pre-flight
- **Date:** 2026-05-10
- **Scope:** Full ADR 0005 (no v1/v1.5/v2 cuts) + ADR 0004 slice plan

This plan turns ADRs 0004 and 0005 into a PR-by-PR sequence. The ADRs
are the design-level commitment; this is the assembly order.

## Sequencing principle

Mutator surface lands first (Phase A) so the undo runtime (Phase B)
has something to undo. UI surfaces (Phases C and D) consume the
runtime. Each PR is small, gated by tests, leaves the system in a
working state. No big-bang merges.

## Scope decisions locked at planning time

- **Full ADR 0005, not minimal.** Bulk mutators, CAS / `expected`,
  outcome channel, friction toasts, and reorder coalescing all land
  before list-view slices begin. Trade-off: more pre-list-view work,
  but list-view slices land on a complete substrate.
- **`setItemFields` lands eagerly in Phase A**, not deferred to Slice
  D. Schema work is finished before UI surfaces touch it.
- **Phases A → B → C → D in order.** Some parallelization is possible
  inside each phase (notes below), but cross-phase parallelism is
  intentionally avoided so each phase's tests can gate the next.

## Pre-flight: B.1 mini-ADR before any code lands

B.1 (the per-mutation outcome channel) has one architectural unknown:
the DO's `clientID → WebSocket` registry. Three known constraints
that shape the design:

- **Multiple websockets per viewer session.** Every connected client
  has at least one websocket (the existing pull-poke transport). The
  registry has to map a Replicache `clientID` (which the DO knows from
  the push payload) to the right websocket without ambiguity.
- **Reconnects.** Websockets drop and reconnect; the registry must
  survive that without leaking entries or losing the `clientID`
  binding across reconnects.
- **Multi-tab same-account.** One account with two tabs open on the
  same list has two `clientID`s and two websockets. Outcome events
  must reach the originating tab only, not both — ADR 0005's
  per-tab undo model relies on this.
- **Existing fan-out lives in `workers/src/list/durable_object.ts`.**
  The pull-poke broadcasts to all connected websockets on the entity;
  outcome events instead are *unicast* to one. Different routing
  pattern in the same DO.

**Before starting B.1, this lands as ADR 0006 (or similar):**

1. Spike: read the existing websocket attach/detach paths in the DO.
   Confirm whether `clientID` is already available at attach time, or
   needs to be added to the websocket handshake / first message.
2. Decide between:
   - **(α) Registry inside the DO** — `Map<clientID, WebSocket>`,
     populated on attach, cleaned on close. Unicast on outcome.
   - **(β) Fan-out + filter** — broadcast outcome to all sockets on
     the entity; client filters by its own `clientID`. Wastes
     bandwidth proportional to viewer count; simpler server.
   - **(γ) Hybrid** — broadcast for low-traffic outcomes (`ok`),
     unicast for failures (`auth | stale | gone`). Reasonable but
     inconsistent.
3. Pick one, write up the trade-off, file as ADR 0006.
4. **Amend this plan if the choice meaningfully changes B.1's PR
   shape** — particularly if the spike reveals that `clientID` isn't
   currently surfaced at the websocket layer and needs a separate
   handshake-extension PR before B.1 itself.

The pre-flight is not gating Phase A. Phase A can start in parallel
with the spike; B.1 gates only on the spike completing.

## Phase A — Mutator surface (server-side foundation)

| PR | Adds | Touches | Tests |
|---|---|---|---|
| **A.0** | Type signatures for `inverse`, `capturePreState`, `expected` peer arg, friction registry. New exports are optional at the type level until A.6 enforces; this PR is no-op runtime. | `workers/src/list/mutators/_shared.ts`, `workers/src/list/mutators/index.ts` (Mutations map types) | type-check only |
| **A.1** | `setItemFields` (umbrella). `capturePreState` reads only the keys present in `args.fields`. `inverse` swaps `fields ↔ expected`. Migrate `pickReference` in `List.svelte` to call it. Delete `setItem.ts`; rename `updateListItem` → `updateListItemFields`. | NEW `workers/src/list/mutators/setItemFields.ts`, `workers/src/list/sql.ts`, `workers/src/list/mutators/index.ts`, `pages/src/lib/components/List.svelte` | new `setItemFields.test.ts`; existing `createListItem.test.ts` regression |
| **A.2** | `setGroupFields` (umbrella). Symmetric to A.1 for groups (name + description + parent_element_ref). | NEW `setGroupFields.ts`, `sql.ts` group helper, `index.ts` | `setGroupFields.test.ts` |
| **A.3** | `setItemsAtomic` + `setGroupsAtomic` (bulk umbrella). Same shape but `{items: [...]}` / `{groups: [...]}`. CAS all-or-nothing across the batch. | NEW mutator files, `sql.ts` batch helpers (single transaction wrapping N updates) | bulk tests covering atomicity-on-mismatch |
| **A.4** | Archive/restore item mutators that don't exist yet: **`archiveListItem`**, `unarchiveListItem`, `archiveListItems`, `unarchiveListItems`. Pair-wise inverses. | 4 NEW mutator files, `sql.ts` archive/restore helpers | per-mutator tests; one test asserting `archiveListItem`'s inverse is `unarchiveListItem` and vice versa |
| **A.5** | Group-level archive/restore: `archiveListGroup`, `unarchiveListGroup`, `archiveListGroups`, `unarchiveListGroups`. Same shape as A.4. | 4 NEW mutator files, `sql.ts` | group archive tests |
| **A.6** | `unarchiveList` (paired with existing `archiveList`). Add `inverse` + `capturePreState` exports to **every** existing mutator. Add `expected` arg + CAS implementation to all set-family mutators (`renameList`, `setDescription`, `setItemQuantity`, `setListAuthRules`, plus the umbrellas from A.1–A.3). Tighten `_shared.ts` types so `inverse` becomes required at compile time. | every file in `workers/src/list/mutators/`, `_shared.ts`, `index.ts` | per-mutator inverse tests; CAS mismatch tests; one type-level test asserting all entries in `Mutations` declare `inverse` |
| **A.7** | Reorder mutators: `reorderListItem`, `reorderListGroup`. Inverse is reorder-back; `capturePreState` records prior position in parent's `child_element_refs`. Used by Slice F + the runtime's coalescing logic. | NEW mutator files, `sql.ts` reorder helper (mutates parent's `child_element_refs` array atomically) | reorder + reorder-back inverse tests |
| **A.8** | `initFromTemplate` mutator. Inverse is `archiveList` of just-created list. Friction-tier flagged. | NEW mutator file, DO-to-DO copy logic | template-fork test |

**End of Phase A:** every mutator the system needs exists, every
mutator declares `inverse`, every set-family mutator does CAS. No
client-side undo yet, but everything is `Cmd+Z`-able the moment the
runtime lands.

**Parallelism inside Phase A:** A.0 is the only strict prerequisite.
After A.0, A.1–A.5 can land in any order. A.6 blocks on A.1–A.5
because it tightens types across the full mutator set. A.7 and A.8
can land alongside A.6 or after.

## Phase B — Undo runtime + outcome channel

Pre-flight spike (above) gates B.1. B.2 and B.3 land sequentially
after.

| PR | Adds | Touches | Tests |
|---|---|---|---|
| **B.1** | Per-mutation outcome channel server-side: `clientID → WebSocket` mapping per the choice from the pre-flight ADR. On every `executeServerMutation` result, emit `{type:'mutation_outcome', clientID, mutationID, status}` over the originating client's transport. CAS-stale and target-gone become structured statuses (today they no-op silently / throw). | `workers/src/list/durable_object.ts`, `workers/src/list/mutators/index.ts` (executeServerMutation result extension) | DO test asserting outcome frames fire on each status |
| **B.2** | `withUndo` runtime client-side: sessionStorage stack keyed `(accountId, listId)`, 50-entry bound, fire-mode discrimination (forward / inverse / redo / system), pre-state capture at fire time via `capturePreState`, friction-tier registry, pre-flight auth check, outcome-frame listener with toast dispatch. Two firing paths: `mutate.foo()` (system) and `mutateWithUndo.foo()` (user). | NEW `pages/src/lib/replicache/withUndo.svelte.js`, `pages/src/lib/replicache/index.svelte.js` (compose with existing `wrapMutators`) | runtime tests with mock `mutate` and mock outcome events; assertions on stack push/pop, redo clear, friction prompt invocation |
| **B.3** | Reorder coalescing: 500ms window of same-element same-mutator → merge into one entry whose preState is the position before the *first* move. Symmetric on redo. | `withUndo.svelte.js` | coalescing tests with mock clock |

**End of Phase B:** `Cmd+Z` works end-to-end at the JS layer. No UI
surface yet — invoking via console works.

## Phase C — UI surfaces for undo

| PR | Adds | Touches | Tests |
|---|---|---|---|
| **C.1** | Toast component (`<UndoToast>`) with Undo CTA and keystroke label *"Undo (Cmd+Z)"*. Most-recent-wins collapse on rapid-fire. Wired into `withUndo`'s `onToast` callback. | NEW `pages/src/lib/components/UndoToast.svelte`, `+layout.svelte` mount | component test |
| **C.2** | Two-step confirm-toast variant for friction-tier mutators (`setListAuthRules`, `initList`, `initFromTemplate`). `y` / `n` hotkey pattern. Standardized for any future confirm-toast (the open-question follow-up in ADR 0005). | `UndoToast.svelte` (variant) | confirm-flow test |
| **C.3** | Wire `Cmd+Z` / `Cmd+Shift+Z` into the global keymap. Bind `Cmd+Shift+S` → share route stub (route itself is a placeholder until #8 lands). | `+layout.svelte` keymap, NEW `pages/src/routes/l/[id]/share/+page.svelte` (placeholder) | e2e undo via key |

**End of Phase C:** end-to-end undo working with toasts, confirm
friction, and proper UX. No list-view changes yet — undo operates on
the existing UI surface (title edit, picker, checkbox toggle).

## Phase D — List view (ADR 0004 slice plan)

| PR | Slice | Notes |
|---|---|---|
| **D.0** | Preludes | Each-block keying fix (`{#each ... (id)}` for cursor stability under remote mutation) + focusable `<article tabindex="-1">` container + auto-focus on mount via `tick().then(focus)`. Pure scaffolding for D.1. |
| **D.1** | Slice A: cursor only | `j`/`k`/`↓`/`↑`/`h`/`l`/`Home`/`End`/`Esc`-blur. ID-tracked cursor. No mutations. Group collapse via `localStorage`. Tested under simulated remote insert/delete to verify cursor doesn't jitter. |
| **D.2** | Slice B: single-row verbs | `Cmd+Backspace` (`archiveListItem`), `Space` toggle (`setItemQuantity`), `+`/`-` step, `x` selection toggle, `Shift+↓`/`Shift+↑` extend. All flow through `mutateWithUndo`; `Cmd+Z` reverts each. |
| **D.3** | Slice C: selection bulk | `Cmd+A` select-at-depth, bulk `Cmd+Backspace` (`archiveListItems`), bulk `Space` (`setItemsAtomic` with `fields:{value}`), homogeneity enforcement (mixed selection replaces). |
| **D.4** | Slice D: inline create + full edit panel | `n` / `g` inline create (`createListItem` / `createListGroup`), `Enter` opens edit panel, `Cmd+Enter` commits (`setItemFields` for items, `setGroupFields` for groups, `setItemsAtomic` for bulk). The "—" semantic for disagreeing cells in bulk-edit. |
| **D.5** | Slice E: group ops | `Shift+Space` check-all-in-group, group reorder, group archive (`archiveListGroup`). |
| **D.6** | Slice F: reorder | `Cmd+↑` / `Cmd+↓` (`reorderListItem` / `reorderListGroup`). Coalescing already exists in B.3; this slice wires gestures. |
| **D.7** | Slice G: list-level + cheatsheet | `Cmd+Shift+A` archive list, `?` cheatsheet overlay, `Cmd+K` palette stub. The keymap reference (`docs/keymaps/list-view.md`) likely migrates to TS source-of-truth (`pages/src/lib/keymap/list-view.ts`) here, since the cheatsheet is the second consumer ADR 0004 §References named. |

**End of Phase D:** ADR 0004 fully realized. List view is
keyboard-first, multi-select, undo-aware, ID-tracked under remote
mutation.

## Critical-path notes

- **A.0 is the only PR that has to land first.** Everything in Phase A
  can be reordered or parallelized after that.
- **Phase B can start once A.6 lands** (it needs `inverse` /
  `capturePreState` enforced). A.7 and A.8 can be in flight in
  parallel.
- **Phase C is independent of Phase A** after B.2 lands. Toast
  component can be drafted in parallel.
- **D.0 and D.1 don't need any of A–C** — they're pure read+keyboard.
  If priorities shift, D.0+D.1 can jump the queue.
- **The DO `clientID → websocket` registry in B.1 is the highest-risk
  piece of the whole plan.** That's what the pre-flight spike + mini-ADR
  resolves.

## Test discipline per PR

- Every new server mutator: `workers/test/<name>.test.ts` matching the
  `entityMetadata.test.ts` pattern.
- Every new client mutator wrapper: a runtime test in `pages/test/`
  (or `workers/test/` if shared) with a mock Replicache.
- Every new keymap binding in Phase D: a Playwright test asserting the
  gesture → mutation → expected DOM state.
- The runtime-level invariants (γ-registration, all-or-nothing CAS,
  fire-mode discrimination) get one test each, not per-mutator.

## Out of scope for this plan

These ADR commitments are deliberately deferred:

- **History view (C-archetype)** — its own ADR when committed.
- **Cross-device undo sync** — rejected for v1, subsumes into
  history-view if ever revisited.
- **Server-side pre-state in mutation log** — rejected for v1.
- **Touch / mobile parity for the keymap** — explicitly out of scope
  per ADR 0004 §"Open questions."
- **Filter / search (`/`)** — key reserved, verb undesigned.
- **Group-into-item / item-into-group conversion** — deferred per
  ADR 0004.
- **`/<l|t>/<id>/share` full UI** — placeholder lands in C.3; full
  build is its own design conversation that has to address the
  self-demotion forward-warning copy from ADR 0005.

## Estimated PR count

Phase A: 9 PRs · Phase B: 3 PRs · Phase C: 3 PRs · Phase D: 8 PRs ·
Pre-flight: 1 ADR · **Total: ~24 units**

Each PR is small (a few files, a few tests). Reviewable in 15–30
minutes individually. The full sequence is multi-week work.

## References

- `docs/adr/0004-list-view-keyboard-and-cursor-model.md`
- `docs/adr/0005-undo-and-inverse-mutators.md`
- `docs/keymaps/list-view.md`
- `docs/adding-a-mutator.md`
- ADR 0006 (TBD) — `clientID → WebSocket` routing in the DO. Pre-flight
  for B.1.
