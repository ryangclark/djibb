# Keymap: List view (`/l/<id>` and `/t/<id>`)

The decision and reasoning behind this keymap live in [ADR 0004](../adr/0004-list-view-keyboard-and-cursor-model.md). This file is the binding table — a living document that changes as features land. Both `/l/` and `/t/` use this exact keymap; template-only divergences are field defaults, not key bindings.

> **Source-of-truth note.** The runtime keymap now lives in `pages/src/lib/keymap/registry.js` (plus `listView.svelte.js` / `listViewVerbs.svelte.js`), which powers the cheatsheet (`?`) and command palette (`Cmd+K`). This markdown table is no longer the authority — it is kept in sync by hand (automatic regeneration from the registry is still pending). Edit both when bindings change.

## Conventions

- **`Cmd`** = `Cmd` on macOS, `Ctrl` on other platforms. Use `meta` in code; the implementation translates.
- **`+` and `-`** without modifiers are the unshifted `=` and `-` keys, so they don't require holding Shift. This matches Mac standard for "zoom in / zoom out" feel.
- Single-key shortcuts only fire when the **list container has focus**. Inside any input or textarea (edit panel, inline create row, picker search, share route), keys go to the input.
- Arrow keys are first-class aliases for `j`/`k`/`h`/`l`. Not vim-only.
- No chords. Every binding is a single keypress (with optional modifiers).

## Navigation (cursor on list, no panel open)

| Key | Action |
|---|---|
| `j` / `↓` | Cursor down |
| `k` / `↑` | Cursor up |
| `h` / `←` | Collapse group, or jump to parent group if already collapsed / on a non-group row |
| `l` / `→` | Expand group, or descend to first child if already expanded |
| `Home` | Jump to first row |
| `End` | Jump to last row |
| `Esc` | Cascade: close panel → clear selection → blur list |

## Cursor on Item

| Key | Action |
|---|---|
| `Space` | Toggle to extremes (`min ↔ target`). Unit-agnostic. |
| `+` (= unshifted `=`) | Step `value` up by 1, clamped to `max_value` |
| `-` | Step `value` down by 1, clamped to `min_value` |
| `Enter` | Open edit panel, focus name field |
| `L` | Open reference picker |
| `Cmd+↑` | Reorder up within parent |
| `Cmd+↓` | Reorder down within parent |
| `Cmd+Backspace` | Delete (no confirm — undo is the safety net once it lands) |
| `x` | Toggle this row in the selection set |
| `Shift+↓` | Extend selection down by one row |
| `Shift+↑` | Extend selection up by one row |

## Cursor on Group

| Key | Action |
|---|---|
| `Space` | Expand / collapse |
| `Shift+Space` | Check all items in group (sets `value = target_value` per item, unit-agnostic) |
| `Enter` | Open edit panel (name + description, no quantity fields) |
| `n` | New item at end of this group |
| `Cmd+↑` | Reorder group up |
| `Cmd+↓` | Reorder group down |
| `Cmd+Backspace` | Delete group (with confirm — destructive cascade. Confirm is removed once undo ships.) |
| `x` | Toggle this group in the selection set |
| `Shift+↓` / `Shift+↑` | Extend selection (group-only, since selection is homogeneous) |

## Selection (homogeneous: all-Items or all-Groups, never mixed)

| Key | Action |
|---|---|
| `Space` | Bulk: each row to its own `target_value` |
| `Cmd+Backspace` | Bulk delete |
| `Enter` | Open edit panel bound to selection. Cells where values disagree show `—`. Committing only writes touched fields. |
| `Cmd+A` | Select all rows at current depth. Pressed again, expands to whole list. |
| `Esc` | Clear selection (visible *and* hidden in collapsed groups) |

## Creation

| Key | Action |
|---|---|
| `n` | New item below cursor (or at end of list if cursor unset / on title row). Opens a lightweight inline name field. `Enter` commits, `Tab` graduates to full edit panel, `Esc` cancels and removes the row. |
| `g` | New group at end of list. Same lightweight name field shape. |

## List-level (anywhere on the page)

| Key | Action |
|---|---|
| `Cmd+K` | Command palette |
| `Cmd+Shift+S` | Open `/<l\|t>/<id>/share` sub-route |
| `Cmd+Shift+A` | Archive list |
| `?` | Shortcut cheatsheet overlay |

`Cmd+S` is intentionally left unbound — browser save wins.

## Edit panel (focus is inside it)

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Next / previous cell |
| `↑` / `↓` (outside textareas) | Up / down cell |
| `Cmd+Enter` | Commit and close panel |
| `Esc` | Discard and close panel |

## Inline create row (focus is inside it)

| Key | Action |
|---|---|
| `Enter` | Commit (creates the row, cursor lands on it) |
| `Tab` | Graduate to full edit panel without committing yet |
| `Esc` | Cancel and remove the placeholder row |

## Reference picker (focus is inside it)

| Key | Action |
|---|---|
| Type | Filter candidate list |
| `↑` / `↓` | Move highlight |
| `Enter` | Pick highlighted candidate |
| `Esc` | Close picker without changing reference |

## Reserved (not bound in v1)

| Key | Reason |
|---|---|
| `/` | Filter / search — verb is undesigned (hide vs dim vs jump). Reserve the key. |
| `Shift+Cmd+N` | "New item at top of list." Use `Home` then `n` instead. Bind only if usage proves the two-press path is too costly. |
| `D` | "Edit description fast path." Description isn't common enough to deserve its own key; Tab from name inside the edit panel is sufficient. |

## Template-only differences (`/t/<id>`)

No keymap divergence. The two real differences are:

1. The edit panel's `value` cell is editable at item creation time on Templates (so a template author can pre-check "preheat oven to 375°F"). On Lists the same cell is editable post-creation but defaults to `0` on create.
2. The share sub-route at `/t/<id>/share` shows footgun-warning copy for permissive `default_role` settings (per `CONTEXT.md`).

## Cursor and selection coherence

These rules are normative and live in [ADR 0004](../adr/0004-list-view-keyboard-and-cursor-model.md#cursor-and-selection-coherence-under-mutation). Summary:

- **Delete focused row** → cursor falls back: next sibling → prev sibling → parent group → none.
- **Delete selection** → cursor → row immediately after the last-deleted row, same fallback chain. Selection clears.
- **Reorder** → cursor follows the moved row.
- **Create** → cursor lands on the new row after commit.
- **Collapse with selection inside** → selection persists by ID, group shows `(N selected)` badge.
- **Collapse with cursor inside** → cursor promotes to the group itself.
- **Expand** → cursor unchanged. To descend, press `→` or `j`.
- **Remote insert above cursor** → cursor tracks by **element ID**, not index. Logical focus stays put.
- **Remote delete of focused row** → same fallback chain as local delete, silent in v1.

## View-state persistence

| State | Where it lives |
|---|---|
| Cursor position | In-memory only. Reload = no cursor. |
| Selection set | In-memory only. Reload = empty. |
| Group collapse-state | `localStorage`, keyed by list ID. Per-viewer, not synced. |

View-state is intentionally never written to Replicache or the mutation log. See ADR 0004 for the reasoning.
