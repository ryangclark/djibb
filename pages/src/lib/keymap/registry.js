// @ts-check

/**
 * Keymap registry — D.7's single source of truth for the list-view
 * keyboard surface. Both the cheatsheet overlay (`?`) and the command
 * palette (`Cmd+K`) render from this list, and the palette uses the
 * `action` callback as its execution path.
 *
 * Per ADR 0004's source-of-truth note in
 * `docs/keymaps/list-view.md`: this registry is intended to become
 * authoritative once the cheatsheet + palette UIs are wired (this
 * slice). The markdown doc will be regenerated from here in a
 * follow-up; until then, treat both as canonical and keep them in
 * sync by hand.
 *
 * @typedef {object} Binding
 * @property {string} keyDisplay   Human-readable key combo, e.g. "⌘⇧S"
 * @property {string} label         Short action name shown in the
 *                                  cheatsheet and palette
 * @property {string} category      One of: Navigation, Item, Group,
 *                                  Selection, Creation, List, Panel
 * @property {string} [description] Longer prose for the cheatsheet
 * @property {(() => void) | null} action  null = informational only
 *                                          (cheatsheet shows it but
 *                                          palette skips it)
 *
 * @typedef {object} RegistryDeps
 * @property {() => void} openCheatsheet
 * @property {() => void} openPalette
 * @property {() => void} closeOverlays
 * @property {() => void} archiveList
 * @property {() => void} navigateToShare
 * @property {() => void} undo
 * @property {() => void} redo
 */

/**
 * @param {RegistryDeps} deps
 * @returns {Binding[]}
 */
export function buildKeymapRegistry(deps) {
    return [
        // Navigation
        { keyDisplay: 'j / ↓', label: 'Cursor down', category: 'Navigation', action: null },
        { keyDisplay: 'k / ↑', label: 'Cursor up', category: 'Navigation', action: null },
        { keyDisplay: 'h / ←', label: 'Collapse group | parent', category: 'Navigation', action: null },
        { keyDisplay: 'l / →', label: 'Expand group | descend', category: 'Navigation', action: null },
        { keyDisplay: 'Home', label: 'Jump to first row', category: 'Navigation', action: null },
        { keyDisplay: 'End', label: 'Jump to last row', category: 'Navigation', action: null },
        { keyDisplay: 'Esc', label: 'Cascade: panel → selection → blur', category: 'Navigation', action: null },

        // Item verbs
        { keyDisplay: 'Space', label: 'Toggle value (min ↔ target)', category: 'Item', action: null },
        { keyDisplay: '+', label: 'Step value up', category: 'Item', action: null },
        { keyDisplay: '−', label: 'Step value down', category: 'Item', action: null },
        { keyDisplay: '⌘⌫', label: 'Archive (undo restores)', category: 'Item', action: null },
        { keyDisplay: '⌘↑ / ⌘↓', label: 'Reorder within parent', category: 'Item', action: null },
        { keyDisplay: 'Enter', label: 'Open edit panel', category: 'Item', action: null },

        // Group verbs
        { keyDisplay: 'Space', label: 'Toggle collapse', category: 'Group', action: null },
        { keyDisplay: '⇧Space', label: 'Check all items in group', category: 'Group', action: null },

        // Selection
        { keyDisplay: 'x', label: 'Toggle selection', category: 'Selection', action: null },
        { keyDisplay: '⇧↓ / ⇧↑', label: 'Extend selection', category: 'Selection', action: null },
        { keyDisplay: '⌘A', label: 'Select at depth (twice: all)', category: 'Selection', action: null },

        // Creation
        { keyDisplay: 'n', label: 'New item (inline)', category: 'Creation', action: null },

        // List-level (callable from palette)
        {
            keyDisplay: '⌘⇧A',
            label: 'Archive list',
            category: 'List',
            description: 'Soft-deletes the entire list. Undo restores.',
            action: deps.archiveList
        },
        {
            keyDisplay: '⌘⇧S',
            label: 'Share',
            category: 'List',
            description: 'Open the share sub-route.',
            action: deps.navigateToShare
        },
        {
            keyDisplay: '⌘Z',
            label: 'Undo last action',
            category: 'List',
            action: deps.undo
        },
        {
            keyDisplay: '⌘⇧Z',
            label: 'Redo last undone action',
            category: 'List',
            action: deps.redo
        },
        {
            keyDisplay: '?',
            label: 'Show keyboard cheatsheet',
            category: 'List',
            action: deps.openCheatsheet
        },
        {
            keyDisplay: '⌘K',
            label: 'Open command palette',
            category: 'List',
            action: deps.openPalette
        },

        // Panel (informational)
        { keyDisplay: '⌘↵', label: 'Commit changes', category: 'Panel', action: null },
        { keyDisplay: 'Esc', label: 'Discard changes', category: 'Panel', action: null }
    ];
}

/**
 * Pure: substring filter over registry entries. Searches across
 * label, keyDisplay, and category (case-insensitive). Used by the
 * command palette. Exported so it's testable without the .svelte.js
 * shell.
 *
 * @param {Binding[]} bindings
 * @param {string} query
 * @returns {Binding[]}
 */
export function filterPaletteBindings(bindings, query) {
    const q = query.trim().toLowerCase();
    if (!q) return bindings.filter((b) => b.action !== null);
    return bindings.filter((b) => {
        if (b.action === null) return false;
        const hay =
            `${b.label} ${b.keyDisplay} ${b.category}`.toLowerCase();
        return hay.includes(q);
    });
}

/**
 * Group bindings by category, preserving registry order.
 *
 * @param {Binding[]} bindings
 * @returns {[string, Binding[]][]}
 */
export function groupByCategory(bindings) {
    /** @type {Map<string, Binding[]>} */
    const m = new Map();
    for (const b of bindings) {
        const existing = m.get(b.category) ?? [];
        existing.push(b);
        m.set(b.category, existing);
    }
    return [...m.entries()];
}
