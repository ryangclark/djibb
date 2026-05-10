# ADR 0005: Undo via paired forward+inverse mutators with client-side stack

- **Status:** Accepted
- **Date:** 2026-05-09

## Context

Undo is described as core to the project; ADR 0004 (List view keyboard and cursor model) was written assuming undo exists, and several of its decisions — `Cmd+Backspace` on items having no confirm, group-delete losing its confirm "the moment undo ships," bulk-delete on selections being forgiven by the undo stack — only land cleanly with a real undo system underneath.

The mutation log is already in place (`workers/src/list/sql.ts:301`, `mutations` table) per ADR 0003's "DO as authority" model. Every Replicache mutation lands as a row keyed by `(client_id, id)`, with `name`, body `args`, `account_id`, and timestamps. Forward replay is therefore well-defined; **inversion is not**. The log carries forward args only — to invert `setItemQuantity({itemId, quantity: {value: 3}})` you need the prior quantity, which the log does not retain.

Three failure modes were identified before any decision was committed:

- **Pre-state capture is the storage cost of generic inversion.** Any "set"-family mutation needs the previous value of the field it touched to invert. Capturing pre-state generically means every mutation pays a JSON-blob cost forever, including the 95% of mutations never undone.
- **Semantic vs structural inversion is where collaboration hurts.** "I checked item X, collaborator deleted item X, I press Cmd+Z" — structural inversion fires `setItemQuantity` against a deleted row and either errors or no-ops; semantic inversion (what the user *meant*) requires conflict-aware reasoning that is OT/CRDT-shaped and disproportionate to the project's complexity budget. Replicache's convergence model is "server assigns global mutation order; clients rebase," not OT — undo expectations diverging from Replicache guarantees is where the bugs live.
- **OT/CRDT creep.** Every step toward "undo always does the right thing under concurrent edits" pulls toward operational transformation. The discipline is to accept structural inversion with explicit failure modes and not try to be OT.

Offline mode is uneventful: mutations and inverses both queue, replay in mutation-order on reconnect, and the conflict-handling that matters happens server-side regardless of when the mutation was originally authored. Collaboration is the hard case.

This ADR commits to a structural shape for undo that bounds each of the failure modes above without inventing new infrastructure.

## Decision

### Personal, per-list, per-tab undo

`Cmd+Z` undoes *the user's own* most recent action on the *current list*. The undo stack is keyed `(account_id, list_id)` and lives in **`sessionStorage`** for the tab, persisted across in-tab navigation but not across tab close. Reload preserves history; closing the tab clears it; another tab on the same list has its own independent stack. Other accounts' actions on the list never enter the user's undo stack.

The stack is bounded at **50 entries**. Push 51st → drop oldest. The redo stack is independently bounded at 50. Pre-state stored per entry can be heavy (a `setItem` undo carries the previous full row); 50 is "I can recover from any reasonable session of mistakes" without stockpiling MB of pre-state across a long-lived session. The bound is on entries, not bytes.

`Cmd+Z` on an empty stack is silent — a subtle audio/visual cue (soft "thunk" or 100ms shake) acknowledges the keystroke without firing a toast. `Cmd+Shift+Z` is redo, with the same bound and the same silent-on-empty cue.

Pre-state lives **client-side only**. The server's mutation log carries forward args only, as it does today. If the C-archetype "history view" (cross-device, time-travel restore) becomes a real product later, server-side pre-state for selected mutators or replay-derivation can be added then; v1 doesn't pay for it.

### One user gesture is exactly one mutation envelope

The unit of undo is the user gesture, defined as one mutation envelope. This is enforced not at the undo layer but at the **mutator-design layer**: every bulk verb in the keymap (ADR 0004) requires a corresponding bulk mutator on the server.

The bulk mutators implied by the keymap:

- `archiveListItems({ids: string[]})` — bulk `Cmd+Backspace` on a selection (item case)
- `archiveListGroups({ids: string[]})` — bulk `Cmd+Backspace` on a selection (group case; selection is homogeneous per ADR 0004)
- `setItemsAtomic({items: [{id, fields, expected?}]})` — bulk `Space`, `Shift+Space`, *and* edit-panel commit. Subsumes the earlier-considered `setItemValuesAtomic`: passing `fields: {value}` covers the value-only case, passing more keys covers the edit-panel case. One mutator, two gestures.
- `setGroupsAtomic({groups: [{id, fields, expected?}]})` — bulk group edit-panel commit (forward compatibility; not currently in the keymap but symmetric with items).

Each is one row in the mutation log, one entry on the undo stack, one event in the future event-bus fan-out, one inverse to apply. A bulk-delete of 12 items is **one undo**; three repeated `n` presses are **three undos**.

Why this is enforced at the mutator layer and not the undo layer:

- The mutation log fragments under client-side gesture grouping. A bulk-delete of 12 items implemented as 12 single-item mutations becomes 12 rows with no "this was atomic" indicator. Replay can't tell atomic-bulk from rapid-fire-individual; future event-bus subscribers (ADR 0003's evolution section) emit 12 `item_archived` events for what was semantically one user action.
- Atomicity is a server-side property. A 12-mutation "gesture" can succeed partially if a collaborator's auth change lands between mutations 6 and 7; with a bulk mutator, the auth gate is checked once and the write is one transaction.
- Inverse fan-out gets weird under partial failure. Twelve client-side inverse mutations with three failing because collaborators touched those items produces a three-way result the user has to interpret. One bulk inverse mutator returns one outcome.

### Paired forward+inverse mutators with targeted pre-state

Every mutator ships with an `inverse` definition alongside its forward. Three categories:

| Category | Pre-state? | Inverse shape |
|---|---|---|
| **Constructive** (`createListItem`, `initList`, `initFromTemplate`) | None | Inverse is an archive mutator on the just-created entity |
| **Archive/restore** (`archiveListItem(s)`, `archiveList`) | None | Inverse is the restore mutator (`unarchiveListItem(s)`, `unarchiveList`) |
| **Set-family narrow** (`renameList`, `setDescription`, `setItemQuantity`, `setListAuthRules`) | The previous value of the single field being changed | Inverse is the same mutator with previous value as args |
| **Set-family umbrella** (`setItemFields`, `setItemsAtomic`, `setGroupFields`, `setGroupsAtomic`) | The previous values of *only* the fields touched by `args.fields` | Inverse is the same mutator with `fields` swapped to pre-state and `expected` set to the post-forward values |

Inverse mutators are first-class mutators in their own right — they live in `workers/src/list/mutators/`, have their own `argsSchema`, their own `requiredRole`, their own server and client functions. Inverse-of-inverse is the corresponding forward (no special "this is an undo" tracking on the server). Redo is mechanically identical to undo, just from the other stack.

There is no parallel "inverse server surface" — every inverse is itself a forward mutator that happens to land the entity in a prior state. The design's per-mutator `inverse` declaration is a small client-side utility ("which forward, with what args, returns me to the prior state"), not a separate server pipeline. This is why `setItem` is being deleted: it was a whole-replace pass-through with one current caller (`pickReference`), and its undo path is better served by the umbrella `setItemFields` shape that targets only changed keys.

Pre-state capture is **targeted, not generic**, and it is **per-mutator declared**. Each set-family mutator file exports a `capturePreState(tx, args) => Promise<object>` that returns *only* the fields its `inverse` will need — co-locating the read shape with the write shape. The umbrella mutators (`setItemFields` etc.) return an object whose keys are exactly the keys present in `args.fields`. Constructive and archive/restore mutators don't export `capturePreState`; their inverses don't read pre-state. The undo runtime persists exactly what `capturePreState` returned to the stack — nothing more.

Every mutator file declares `inverse`, even if the inverse is a no-op (returns `null`). Mandatory registration forces the design-time question "what does undoing this look like?" without forbidding the rare future opt-out. The runtime treats no-op returns as silent-skip — those actions don't enter the stack.

Pre-state is read from the client's Replicache cache at *forward fire time*, before the optimistic write applies. The Replicache cache already holds the rows about to be modified; capturing pre-state is a one-line read with no extra round-trip. The captured pre-state lives on the stack entry — the cache is not consulted again at undo time.

### Defensive conflict policy with toast

Inverses apply only if current state matches the post-forward state. This is a **per-field compare-and-swap (CAS)**, implemented as an optional `expected` arg on every set-family mutator. The arg is a peer to the mutator's body shape — for narrow set-family mutators (`renameList`) it's `{name: string}`; for umbrella set-family mutators (`setItemFields`) it's `{<subset of `fields` keys>}`. The keys present in `expected` *are* the CAS surface. Forward calls don't supply `expected`; undo calls do.

CAS is **all-or-nothing per mutation envelope**. If any key in `expected` mismatches current state, the entire mutation no-ops; partial application is never written. For bulk umbrella mutators (`setItemsAtomic`, `setGroupsAtomic`), one item's mismatch kills the whole batch — the word "Atomic" in the name commits to it. This matches the "one gesture = one outcome" rule and keeps the user-facing toast unambiguous.

There are **three failure modes** the inverse fire path has to surface, not one:

| Mode | Server path | Toast copy |
|---|---|---|
| **Auth-rejected** | `requiredRole` gate fails before mutator body runs | *"Cannot undo — your permissions changed"* |
| **CAS-stale** | `expected` mismatches current state inside mutator body | *"Cannot undo — list/item changed since you made the change"* |
| **Target-gone** | SQL `rowsWritten !== 1` (entity hard-deleted; theoretical for v1) | *"Cannot undo — that item no longer exists"* |

All three converge on a single **per-mutation outcome channel**: the server emits `{type: 'mutation_outcome', clientID, mutationID, status: 'auth' | 'stale' | 'gone' | 'ok'}` over the existing websocket. The client filters by `(clientID, mutationID)` against the runtime's pending-inverse table and dispatches the right toast. One protocol, one handler, three toast variants.

The client also **pre-flights auth** before firing an inverse: the runtime checks `mutator.requiredRole.includes(currentRole)` and, on mismatch, toasts immediately and pops the entry without a server roundtrip. Pre-flight does not bypass the server gate — the server remains authoritative — it only avoids a noisy push-then-fail roundtrip in the common self-demotion case. The race case (auth changes mid-push) still falls through to the outcome channel.

The client's response to any failed inverse:

- **Pop the undo stack entry.** A failed inverse consumes the entry. Otherwise `Cmd+Z` would spam the same failed inverse forever.
- **Toast the user** with the matching copy. Tone is "couldn't apply," not "failed."
- **No retry, no prompt.** Reflexive `Cmd+Z` shouldn't open a modal mid-flow. The toast is the explanation; the next `Cmd+Z` walks back to the previous entry.

Why CAS rather than always-apply (structural):

- Always-apply silently clobbers concurrent collaborator edits in the set-family case. Renaming the list to "Camping," collaborator renaming to "Moab," undoing should not clobber "Moab."
- Always-apply errors loudly when the target is gone (item deleted by a collaborator), which is even worse — undo should be honest about its limits, not crash.

Why CAS per-set-mutator and not generic:

- Generic CAS ("compare full row hash") needs deterministic serialization across client and server, which the codebase does not guarantee. This is exactly why `setItem` (whole-replace) is being deleted in favor of `setItemFields` (key-targeted): the umbrella shape lets per-field CAS work without a row-hash.
- Per-field CAS matches the targeted pre-state pattern above. The mutator already knows which keys it's touching (`args.fields`'s keys, by construction); the CAS check is on the same keys (`args.expected`'s keys, a subset of `fields`'s keys).

CAS is unnecessary on the constructive and archive/restore families. `unarchiveListItem({id})` against an already-unarchived row is naturally idempotent. The check buys nothing and would only complicate the mutator.

The signal channel from server back to client is a **per-mutation outcome channel** carrying `auth | stale | gone | ok` for each `(clientID, mutationID)` over the existing websocket. Resolved at design level (above); the implementation detail that remains is the DO's `clientID → websocket` mapping (the DO has multiple websockets per viewer; routing the outcome to the originating client requires either a registry inside the DO or a fan-out-and-filter approach). Earlier framings of this question as a single "stale signal" were incomplete — it's three failure modes on one channel.

### Auth-rules and init undos require extra friction

Some forward mutations cross authority or structural thresholds where reflexive `Cmd+Z` is dangerous:

- `setListAuthRules` — undoing reverts a permission change. Self-demotion ("I demoted myself from owner to viewer") is a special case that the inverse is **non-invertible by its own auth model**: the inverse requires `OWNER_ROLES`, the forward demoted the actor below it, the undo is rejected by the auth gate. There is no auth-bypass for inverses, ever — undo is a regular Replicache mutation and passes the same gate.
- `initList` and `initFromTemplate` — undoing deletes the entire list. The loudest single undo in the system.

For both classes, undo is gated by a **two-step toast**: pressing `Cmd+Z` (or the regular destructive-action toast's Undo button) opens a confirm toast — *"Confirm undo: revert auth rules change?"* — with explicit Confirm/Cancel buttons. The buttons carry single-key shortcuts (`y` / `n`), reusing the same affordance pattern as the picker's `↑`/`↓`/`Enter` mini-mode. Reflexive `Cmd+Z` spam doesn't accidentally undo through the friction.

Self-demotion specifically warrants a **forward-time warning** in the share-route UI: *"This change is one-way — you won't be able to undo it from this account."* The user who ignores the warning still falls through to the undo-time graceful-fail toast (permission-rejected). Belt and suspenders.

The undo-time graceful fail is itself two-layered: the runtime **pre-flights** the auth check on the client (using the same `requiredRole` the server enforces) before pushing the inverse, and the per-mutation outcome channel handles the race case where auth changes between pre-flight and push. Both layers produce the same toast; the user can't tell which fired.

### Toast-with-Undo-CTA on hard-to-recover actions

Beyond the keystroke, undo surfaces as a 5–10s toast with an Undo button after actions whose effect is hard to immediately re-perform manually:

| Toast on | No toast |
|---|---|
| `archiveListItem(s)`, `archiveList` | `setItemQuantity` (Space toggles to extremes — re-press to recover) |
| `setListAuthRules` (with two-step confirm above) | `renameList` (re-type) |
| `initList`, `initFromTemplate` (with two-step confirm above) | `setDescription` (re-type) |
|  | `setItem` (re-edit) |
|  | reorder (re-reorder; visible) |

The toast button label includes the keystroke for discoverability: *"Undo (Cmd+Z)"*. Mouse users find it; keyboard users learn the shortcut by seeing it advertised in the moment of the action. Toasts collapse to the most-recent on rapid-fire (a bulk-delete of 12 items already produces one toast because it is one mutation envelope; the collapse handles the case of multiple distinct mutations within the toast window).

### Reorder coalescing

Holding `Cmd+↓` to move an item 8 rows produces 8 mutations on the server. Eight undo entries would be tedious. The client coalesces reorders of the same element within **500ms** of the previous reorder of the same element into one undo entry whose pre-state is the position before the *first* move.

Coalescing is **scoped narrow**: reorder only. Other rapid-fire mutations (Space-toggling repeatedly, repeated `n`) keep their per-press undo entries. Reorder is the only mutator with a natural hold-the-key gesture; Space and `n` don't share the property.

Coalescing applies symmetrically to the redo stack: undoing a coalesced reorder of 3 moves is one keystroke that re-applies 3 moves at once.

### View-state stays out of the schema, again

The undo stack and pre-state are per-viewer client state. They are stored in `sessionStorage` (entries) and Replicache cache (pre-state read at fire time). They are never written to the server. ADR 0004's principle ("the platform's concern is the entity; the frontend's concern is the viewing of it") applies here too. The mutation log records what *was done*; what *can be undone* is per-viewer and ephemeral.

If cross-device undo sync ever becomes a product requirement, the right shape is a separate, app-side concern — owned by djibb.com, not by the djibb platform — and almost certainly subsumes into the C-archetype history-view feature instead of being its own thing.

## Pros and cons against alternatives

### What paired forward+inverse with targeted pre-state wins (vs generic pre-state capture)

- **Storage cost is targeted, not blanket.** Set-family mutators capture only the fields they touched; create/archive don't capture at all. Under generic capture, every mutation pays a pre-state cost forever, including the 95% never undone.
- **Inverse semantics are reviewable per mutator.** Reading any mutator file, a developer can answer "what does undoing this look like?" Generic capture hides this in a generic mechanism; the answer to "is this even reasonably undoable?" is one layer of abstraction away.
- **Design-time scrutiny.** Every new mutator must answer "what's your inverse?" before shipping. The weird ones — `setListAuthRules` with self-demotion, `initFromTemplate` with cascade — get caught at design time, not at undo-test time.
- **Composes with the existing mutator pattern.** `docs/adding-a-mutator.md` is the canonical checklist; we extend by one item ("define `inverse`"). No architectural shift, no new module.

### What generic pre-state capture would have won

- **Less per-mutator design work.** A generic inverter handles every mutation uniformly.
- **No inverse-mutator surface area.** No `unarchiveListItem` / `unarchiveListItems` / `unarchiveList` to maintain.

The targeted approach pays modest per-mutator design work for storage targeting and design-time scrutiny. Both wins matter more, in steady state, than the surface-area savings.

### What replay-derivation would have won (vs targeted capture)

- **Zero per-mutation storage cost.**
- **Pre-state always available** (modulo replay time).

Replay-derivation is O(N) per inversion, requires deterministic mutators, and breaks under concurrent mutations whose order matters. Practically a non-starter for a collaborative app.

### What defensive (B) wins over always-apply (structural)

- **No silent clobber under concurrent edits.** The "I rename to Camping, collaborator renames to Moab, I undo" scenario refuses to clobber rather than silently reverting Moab.
- **Honest failure modes.** Target-gone produces a toast, not a silent no-op or a crash.
- **Bounded surprise.** The user can always trust that their undo either applied as expected or surfaced *why it didn't* — never silently did the wrong thing.

### What always-apply would have won

- **Simpler.** No CAS arg on set mutators, no signal channel for stale.
- **Always-fires.** User never sees a stale toast.

The simplicity is illusory: silent clobber under collaboration is the kind of bug that destroys trust, and a system that never says "couldn't undo that" doesn't tell the truth.

### What defensive-with-prompt (C) would have won

- **User has a chance to override.** "Your undo would clobber [collaborator]'s change — proceed?"

Reflexive `Cmd+Z` shouldn't open a prompt. Undo is supposed to be reflexive; a mid-flow modal breaks that. The two-step confirm toast for auth/init undos covers the "actually you should think before undoing this" case where it genuinely matters.

## Consequences

**Positive:**

- Undo is a real, designed system, not a feature retrofitted onto bare mutations. ADR 0004's "no-confirm on item delete" stance is honest.
- The mutator pattern grows by one slot (`inverse`); the discipline is captured in `docs/adding-a-mutator.md` as a checklist item, not a tribal-knowledge practice.
- Bulk verbs are atomic by construction — every gesture in the UI has one log entry, one event, one inverse. The mutation log is uniformly granular at the gesture level.
- The schema and mutation log stay clean of view-state. ADR 0003's authority model is unaffected.
- Self-demotion via `setListAuthRules` is a known case with a known UX (forward warning + graceful undo-time fail), not a buried bug.

**Negative:**

- Inverse mutators (`unarchiveListItem`, `unarchiveListItems`, `unarchiveList`) are new server-side surface area. Each is small and parallels its forward, but they are real code and real tests.
- Set-family mutators carry an optional `expected` arg (a peer object whose keys are a subset of the body's touched-field keys). One more thing for callers to get right; one more thing to test.
- A new client-side runtime module (`withUndo`, wrapping the existing envelope-injecting `wrapMutators`) holds stack/coalescing/firing. Two layers, two firing paths: `mutate.foo()` for system / inverse / redo; `mutateWithUndo.foo()` for user-initiated forward.
- Each mutator file grows two new exports: `inverse` (mandatory; may return `null` for opt-out) and `capturePreState` (set-family only). The discipline is captured in `docs/adding-a-mutator.md`.
- The per-mutation outcome channel design is committed; the DO's `clientID → websocket` routing is the remaining implementation detail. Until it ships, the inverse no-ops correctly server-side but the client-side toast wording may be generic.
- Two-step confirm toast is a new UI surface (the friction toast). Small but real. The y/n hotkey pattern needs to be standardized across all confirm toasts to stay consistent.
- 50-entry stack bound is a guess. Telemetry-driven adjustment expected.

## Alternatives considered

- **(a) Global undo (Cmd+Z undoes the most recent action on the list, mine or someone else's).** Rejected — almost never appropriate in a collaborative app; users do not expect Cmd+Z to undo a collaborator's work without consent.
- **(b) Time-travel / history-view as the v1 undo surface.** Rejected as the v1 product — it is a different shape (timeline UI, diff view, selective restore) and will eventually exist on top of the personal-undo foundation, not in place of it.
- **(c) Generic pre-state capture in the mutation log.** Rejected on storage and reviewability grounds; covered above.
- **(d) Replay-derivation of pre-state.** Rejected on performance and concurrency grounds; covered above.
- **(e) Client-side gesture grouping over per-item mutations.** Rejected — fragments the mutation log, breaks atomicity, complicates inverse fan-out under collaborator conflicts.
- **(f) Always-apply (structural) inverse policy.** Rejected — silent clobber under collaboration.
- **(g) Defensive with prompt** (C in Q4). Rejected — undo is reflexive, mid-flow prompts break that.
- **(h) Confirm modal for auth/init undos.** Rejected in favor of two-step confirm toast — stays in the toast vocabulary, no new modal surface.
- **(i) Different keystroke for friction-tier mutators (`Cmd+Shift+Z` requires confirm; `Cmd+Z` silently skips).** Rejected — undo stack and action history would disagree, which is exactly the kind of thing that confuses users when they hit it.
- **(j) Auth-bypass for inverses.** Rejected outright — security hole. Inverses are full Replicache mutations and pass the same gate as any other.
- **(k) Generic time-window coalescing across all mutators.** Rejected — Space/checkbox coalescing has ambiguous intent (one undo or two for two presses?). Reorder is the only mutator with an unambiguous hold-the-key gesture.
- **(l) Server-side pre-state in `mutations.pre_state` column.** Rejected for v1 — overkill for personal-undo. Reasonable when history-view becomes real, on a per-mutator basis.
- **(m) Cross-device / synced undo stack.** Rejected — out of scope for personal undo; conflates with history-view if ever needed.
- **(n) Byte-bounded stack (e.g. 1MB total pre-state).** Rejected for v1 — entry-bounded is simpler. Revisit if any single entry's pre-state explodes (the edit-panel-commit-once rule should prevent that).
- **(o) Unbounded stack.** Rejected — long-lived sessions would stockpile pre-state with diminishing user value.

## Open questions

- **Per-mutation outcome channel — design resolved, implementation detail open.** The `{auth | stale | gone | ok}` channel over the existing websocket is committed (above). Open: the DO's `clientID → websocket` routing — registry vs fan-out-and-filter. Decision at implementation time.
- **History view (C-archetype).** A timeline UI with selective restore. Plausible on top of the existing mutation log. Out of scope; its own ADR when committed.
- **Cross-device sync of undo stack.** Considered and rejected for v1. The right shape, if ever revisited, is to subsume into history-view rather than build a separate sync surface.
- **Server-side pre-state for selected mutators.** Currently no server-side pre-state. If history-view lands, specific mutators may grow `mutations.pre_state` columns or replay-derivation paths.
- **Coalescing policy for non-reorder rapid-fire.** Reorder is the only coalesced mutator at v1. If user research surfaces other rapid-fire patterns (rapid Space-toggling on a single item?), this can be widened, but conservatively.
- **50-entry bound.** Telemetry-driven; revisit when usage data is available.
- **`y` / `n` hotkey pattern in confirm toasts.** Generalizes to any action-bearing toast; should be standardized as a small cross-cutting affordance pattern. Worth its own follow-up note in the keymap docs when the toast component is built.

## References

- ADR 0003 — DO as authority for entity metadata; D1 as derived read index. Mutation log lives in the DO; this ADR builds on it.
- ADR 0004 — List view keyboard and cursor model. Several decisions there assume undo exists in the shape this ADR commits to.
- `docs/adding-a-mutator.md` — extended in this commit cycle with the inverse-design checklist item.
- `workers/src/list/mutators/_shared.ts` — `EDIT_ROLES`, `OWNER_ROLES`, `MutationEnvelopeArgsSchema`, `ServerMutator`, `ClientMutator`. The mutator pattern this ADR extends.
- `workers/src/list/sql.ts:301` — `mutations` table schema. Forward log; pre-state intentionally not stored server-side in v1.
- Design conversation 2026-05-09 — the interview that produced this decision, immediately following the ADR 0004 design conversation.
