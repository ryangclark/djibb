# ADR 0004: List view keyboard and cursor model

- **Status:** Accepted
- **Date:** 2026-05-09

## Context

The List view (`pages/src/routes/l/[id]/+page.svelte`, rendering through the shared `<List>` component at `pages/src/lib/components/List.svelte`) is a stub. It has inline title editing, a checkbox-only item row, a placeholder toolbar (`[Remix] [Share] [Export] [Print] [Add Item or Group]`), a quick-add form, and a reference picker. It has no keyboard navigation, no multi-select, no description editor, no group creation in the UI, no reordering, and no archive surface despite the supporting mutators having recently landed (`archiveList`, `setDescription`, `setListAuthRules` in commit `8d8d916`).

The template view (`pages/src/routes/t/[id]/+page.svelte`) renders through the same `<List>` component. Anything decided here applies to both surfaces by construction; the only divergences are field defaults (Templates can pre-check items, per `CONTEXT.md`) and the share-route's footgun-warning copy for permissive `default_role` on Templates.

The opportunity, before feature work begins, is to commit to a foundation that:

- **Is keyboard-first.** The eventual product is checklists used at speed — recipes mid-cook, packing lists mid-pack, secret santa mid-shop. A mouse-only model would be a permanent tax on the use cases djibb is most distinctive at. Hotkeys for actions are an explicit goal.
- **Treats the cursor and the selection as separate concepts.** Multi-select is a stated requirement ("ways to select/edit/check multiple items"). Conflating "what I'm focused on" with "what I'm acting on" forces single-selection workflows or invents weird modal switches; keeping them separate is the model Linear, Things, Superhuman, and Notion converged on.
- **Matches the domain's primitives, not a mock-up of them.** `CONTEXT.md` is emphatic that `Quantity` is the unifying primitive — checkbox is just `unit: 'bool'`. A UI that only renders the boolean case bakes a checkbox-shaped mental model into users that has to be retrofitted out later.
- **Survives collaboration.** Replicache + websockets means rows can move under the cursor at any moment. The cursor model has to be defined against IDs, not row indices, or it will jitter every time a collaborator types.
- **Is shared between `/l/` and `/t/` from day one.** Two routes, one component, one keymap, one mental model.

This ADR captures the decision and the non-negotiables. The actual binding table is a living document and lives at [`docs/keymaps/list-view.md`](../keymaps/list-view.md), referenced from here.

## Decision

### Selection model: cursor plus homogeneous selection set

The List view has two independent state concepts:

- **Cursor.** At most one row is "focused" at a time. The cursor moves with `j`/`k` and arrow keys; it traverses both Items and Groups.
- **Selection set.** Zero or more rows are "selected." Selection is added to with `x` (toggle) or `Shift+arrow` (extend). Selection is **homogeneous**: a selection contains only Items *or* only Groups, never both. Adding a Group to an Item-selection (or vice versa) replaces the set.

`Esc` is the universal backout: panel open → close panel; else selection non-empty → clear *all* selection; else cursor active → blur list. Three cascading levels, single key.

#### Why cursor and selection are separate

Mixing them ("the focused row is always selected") is the Finder model and forces awkward workflows: you can't peek at a row's siblings without un-acting on the thing you were about to act on. Keeping them separate lets the user navigate freely while preserving the working set, and lets bulk actions ("check all 12 ingredients I just selected") feel deliberate rather than incidental.

#### Why homogeneous

Mixed selection forces every bulk verb to invent a "what do I do with the wrong type" rule. `Cmd+Backspace` on a mixed set is one mutation when the set is all Items and a fundamentally different mutation (group delete cascades) when it's all Groups. Mixed-set rules are either confirm-everything (annoying) or silently-skip-some (terrifying). Homogeneous selection makes every bulk verb total over its set.

### Cursor scope and the meaning of Space

The cursor stops on both Items and Groups. `Space` is the universal "act on this row":

- On an Item: toggle to extremes (`min ↔ target`), unit-agnostic. From `1/3 nights`, Space → `3/3`. Press again → `0/3`. Same key on a checkbox: `[ ] → [x]`.
- On a Group: expand / collapse.

A separate `Shift+Space` on a Group means "check all items in this group." This is loud enough to deserve its own key — overloading Space to "toggle all 14 children at once" is a footgun on the most-used key on the keyboard.

### Edit mechanics: in-place row-expanding panel

Pressing `Enter` on a row expands it in place into an edit panel:

- For Items: `[name] [qty] [unit] [target]` cells, `[description ………]` textarea below.
- For Groups: `[name]` and `[description]`. No quantity.
- For a non-empty selection: the same panel binds to the set; cells where values disagree show `—` and committing only writes touched fields.

The cursor stays where it was; the row got taller. `Cmd+Enter` commits, `Esc` discards. `Tab`/`Shift+Tab` traverses cells.

In-place expansion was chosen over a focus-trapping modal because:

- The cursor's position never changes, which preserves the "where am I" signal across an edit.
- The same component handles single-row edit and bulk-edit on a selection, with no separate bulk-edit modal to design.
- `Esc` continues to mean "back out one level" without losing the row context.

A modal would force focus-trap discipline, hide the surrounding list during edit, and split the edit code path between single and bulk cases.

### Hotkey philosophy: hybrid

Single-key shortcuts when the *list container* has focus, for navigation and constructive/common verbs. `Cmd`-prefixed shortcuts for destructive and list-level verbs. `Cmd+K` opens a command palette as the discoverability backstop. `?` opens a cheatsheet overlay. No chords (no `g g`, no leader keys).

The single-key shortcuts only fire when the list container has focus. Inside any input or textarea — the edit panel, the inline create row, the picker search — keys go to the input and the global keymap is dormant. There is no "list mode vs insert mode" toggle; focus *is* the mode.

Pure-vim was rejected because the discoverability cliff is real (a user who doesn't know `?` exists will never find it), and chord idioms are out of place outside a text editor. Modifier-heavy (everything is `Cmd+something`) was rejected because the 90% path — `j`/`k`/Space/Enter/`n`/`+`/`-` — should not require a modifier; the cost of a modifier on every navigation press accumulates fast in actual use.

### Cursor and selection coherence under mutation

This section's rules are the ones most likely to be implemented wrong by accident, and the ones that distinguish "feels good" from "feels broken." They are normative.

- **Delete focused row.** Cursor falls back to: next sibling → prev sibling → parent group → no cursor. This makes chained deletion feel continuous.
- **Delete selection.** Cursor lands on the row immediately after the last-deleted row, same fallback chain. Selection clears.
- **Reorder.** The cursor follows the moved row. (If it stayed put, a second `Cmd+↓` would reorder a different row — broken.)
- **Create new item / new group.** A lightweight inline name-only field opens at the new row's position (`Enter` commits, `Tab` graduates to the full edit panel, `Esc` cancels and removes the row). After commit, the cursor lands on the new row. This is one model with two entry points: keyboard (`n`/`g`) and mouse (the `[+ Add Item]` button). The previous quick-add form is replaced by this flow.
- **Edit panel commit/discard.** Cursor stays on the row, panel closes.
- **Bulk Space / Shift+Space.** Cursor and selection unchanged.

### Selection across collapse

Selection persists by ID across collapse. A collapsed group containing selected descendants shows a `(N selected)` badge. Bulk verbs apply to hidden selection just as they do to visible selection. `Esc` clears selection regardless of visibility.

The alternative — "collapse drops descendants from selection" — removes the "acting on something I can't see" risk but kills the workflow of selecting in one part of the tree, collapsing, scrolling, and acting elsewhere. The badge makes the hidden state legible enough that the workflow win outweighs the surprise risk.

### Cursor tracking under remote mutation

The cursor tracks a row by **element ID**, not by index. When a collaborator inserts a row above the cursor, the cursor's screen position shifts down by one but the logical focus stays on the same Item. When a collaborator deletes the focused row, the cursor falls back through the same chain as a local delete. When a collaborator reorders the focused row, the cursor follows the row.

This is the single most important detail in the model. Index-based tracking is what makes naive collaborative checklists feel jittery. ID-based tracking is invisible when it works and noticeable in its absence.

### View state lives outside the schema

Cursor position, selection set, and group collapse-state are per-viewer UI state. They are stored in `localStorage` (collapse) or in-memory only (cursor, selection). They are never written to Replicache, never enter the mutation log, never sync across collaborators.

The platform's concern is the entity (List, Group, Item, hierarchy, auth). The frontend's concern is the viewing of it (cursor, selection, collapse, sort, filter). The boundary kept here matters: pushing UI state into the schema would pollute the mutation log with view-changes that nobody wants to replay, and would expand the surface area subject to ADR 0003's authority guarantees for no real gain.

If a future product requirement wants cross-device view-state sync (e.g. "remember which groups I had collapsed"), the right shape is a separate, app-side entity (a config list tied to the list) — owned by djibb.com, not by the djibb platform. That is a deferred problem and out of scope for this ADR.

### Quantity is rendered unit-aware

`unit: 'bool'` renders as a checkbox. Other units render as a stepper: `0/3 nights [+] [−]` with `+`/`−` (or `=`/`-` unshifted) stepping `value` by 1 within bounds, no edit panel required. The "done" cue (name strikethrough + dimmed) applies whenever `value === target_value`, regardless of unit.

Quick-add creates `unit: 'bool'`. Changing unit is an explicit edit-panel action. This keeps the 90% case (a checkbox) free of unit-picker friction while keeping the underlying `Quantity` primitive honest in the UI.

### Template parity is automatic

The same keymap, the same edit panel, the same cursor and selection model apply to `/t/<id>`. The only divergences are:

1. Templates can have items where `value === target_value` at creation time (the "preheat oven to 375°F" pre-check from `CONTEXT.md`). The edit panel exposes this as an editable field on `/t/`; on `/l/` the same field is editable but the default state on item creation is `value: 0`.
2. The share/auth route at `/t/<id>/share` surfaces the footgun-warning copy that `CONTEXT.md` calls for when a Template's `default_role` is `editor`.

No keymap divergence. No second mental model.

## Pros and cons against alternatives

### What the hybrid model wins (vs vim-pure)

- Discoverability via `Cmd+K` palette and `?` cheatsheet, no oral tradition required.
- Destructive actions earn a modifier; mistake-cost gradient maps to keymap gradient.
- Familiar to users who already use Linear / Notion / Things; no special training.

### What vim-pure would have won (vs hybrid)

- Tighter keymap (no Cmd-prefixed actions at all; everything is one keypress).
- Power-user ceiling is higher.
- No reliance on a palette as a discoverability backstop.

The hybrid model accepts a slightly looser keymap in exchange for being learnable by users who don't already know it. djibb is not an editor; the keymap shouldn't pretend to be one.

### What in-place edit panel wins (vs modal)

- Cursor's spatial position is preserved across edits.
- Same component handles single and bulk edit; no separate bulk-edit modal.
- `Esc` cascade stays predictable.

### What modal would have won

- Stronger focus-trap; harder to accidentally type into the underlying list.
- Larger canvas for the edit form.

In-place panel pays a small canvas cost for a major continuity win. The bulk-edit unification alone justifies it.

### What homogeneous selection wins (vs mixed)

- Bulk verbs are total over the selection; no "skip the wrong type" rules.
- Delete-on-selection has a single semantic.

### What mixed selection would have won

- Slightly more flexible "select these random things and act on them all."

The flexibility is theoretical; the semantic confusion is concrete.

## Consequences

**Positive:**

- The List view's hotkey surface is defined before features begin landing, so feature work consumes the table rather than each feature inventing its own keys.
- `/l/` and `/t/` share the same keymap by construction; parity is the default, divergence requires explicit justification.
- ID-tracked cursor and homogeneous selection make remote-mutation and bulk-verb behavior predictable enough to write tests for.
- The schema and mutation log stay clean of view-state; ADR 0003's authority model is unaffected.

**Negative:**

- The single-key shortcuts only work when the list container has focus, which is a discipline the implementation must enforce. A bug here ("arrow keys move cursor while I'm typing in the share dialog") would be confusing.
- The `(N selected)` badge on collapsed groups is a small new visual surface to design and keep correct.
- ID-tracked cursor under remote mutation requires careful state management in Svelte; the wrong refactor could re-introduce index-tracking by accident. Worth a unit test.
- Group-delete keeps a confirm dialog until undo lands, which is one more piece of UI to remove later.

## Alternatives considered

- **(a) Focus-only model (browser-native Tab + Space).** Rejected — no path to multi-select, which was a stated requirement.
- **(b) Selection-only model (selection *is* focus, Finder-style).** Rejected — loses the "navigate without committing to selection" affordance, which matters when groups and items intermix.
- **(c) Mixed selection (Items and Groups in one set).** Rejected — bulk verbs become semantically ambiguous over heterogeneous sets; degrade-gracefully rules are footguns.
- **(d) Pure-vim keymap with chords.** Rejected — discoverability cliff; chord idioms outside a text editor are mannerist, not functional.
- **(e) Modifier-heavy keymap (Cmd-everything).** Rejected — modifier on every navigation press accumulates a tax that the 90% path cannot afford.
- **(f) Modal edit dialog.** Rejected — breaks cursor continuity; forces a separate bulk-edit modal.
- **(g) Selection drops on collapse.** Rejected — kills the "select-in-one-place, work-elsewhere" workflow. Persistent selection with a `(N selected)` badge is the better trade.
- **(h) Index-tracked cursor across remote mutations.** Rejected — guaranteed jitter under multi-user editing.
- **(i) View-state synced through Replicache.** Rejected — pollutes the mutation log with non-replayable changes. View-state belongs on the client; cross-device sync, if ever needed, is a frontend product concern, not a platform concern.
- **(j) Single edit shortcut per field (`R` rename, `D` description, `V` value).** Rejected in favor of the unified edit panel — cheaper to learn one shape than three keys, and the panel's Tab traversal is faster than three discrete keypresses for multi-field edits.

## Open questions

- **Undo.** The user has flagged this as core and is addressing it in a separate work session. The cursor-recovery rules above are written with the assumption that destructive actions are reversible by undo. Group-delete keeps a confirm dialog only until undo ships; once it does, the confirm is removed.
- **Filter / search.** `/` is reserved as a key but the verb is undesigned. Whether filter hides non-matches, dims them, or jumps-to-first-match is its own design surface; out of scope for this ADR.
- **Command palette content.** The palette opens with `Cmd+K`, but its full action list — and whether it surfaces palette-only actions that don't have shortcuts — is not specified here. The keymap file is the source of shortcut bindings; the palette's action set may be a superset.
- **Mobile / touch parity.** The keyboard model is the v1 priority. Touch gestures (long-press for selection? swipe to check? tap-and-hold for edit panel?) are not in this ADR. Touch users today get the existing checkbox + `[+ Add Item]` button; bulk actions are keyboard-only until touch is designed.
- **Cursor across page reload.** Currently no persistence. If demand emerges, sessionStorage is the obvious next step; not on the v1 path.
- **Group-into-item / item-into-group conversion (promote/demote).** Deferred. Useful long-term but not v1.

## References

- [`docs/keymaps/list-view.md`](../keymaps/list-view.md) — the binding table, hand-written for now, intended to move to a TS source of truth (`pages/src/lib/keymap/list-view.ts`) when the cheatsheet UI lands and a second consumer justifies the indirection.
- `CONTEXT.md` — List, Template, ListGroup, ListItem, Quantity-is-the-unifying-primitive.
- ADR 0003 — DO-as-authority. View-state explicitly stays out of this authority model.
- `pages/src/lib/components/List.svelte` — the shared component this ADR's model will be implemented against.
- `pages/src/routes/l/[id]/+page.svelte`, `pages/src/routes/t/[id]/+page.svelte` — the two routes that share the component.
- Design conversation 2026-05-09 — the interview that produced this decision.
