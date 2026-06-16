// @ts-check

/**
 * Global keymap bindings for the list / template routes. Per ADR
 * 0004's keymap surface and ADR 0005's Cmd+Z hookup.
 *
 * Wires:
 *   Cmd/Ctrl + Z              → undoRuntime.undo()
 *   Cmd/Ctrl + Shift + Z      → undoRuntime.redo()
 *   Cmd/Ctrl + Shift + S      → onShareShortcut() (route owns goto)
 *
 * D.7's Cmd+K (palette) and Cmd+Shift+A (archive list) live in
 * List.svelte's own window listener — they need direct access to
 * the overlay state and the list's mutateWithUndo, both of which
 * are adjacent in the component.
 *
 * Skip rules — discipline from ADR 0004:
 *   - Inputs / textareas / contenteditable get first dibs on their
 *     native undo. We don't hijack typing.
 *   - List-view single-key shortcuts (j/k/...) are owned by the list
 *     container, not the window. This helper only handles
 *     modifier-prefixed gestures.
 *
 * Caller wires this in a Svelte `$effect`, capturing the cleanup
 * function it returns.
 *
 * @param {object} input
 * @param {{ undo: () => Promise<boolean>, redo: () => Promise<boolean> }} input.runtime
 *   The undo runtime created by `createUndoRuntime`.
 * @param {() => void} [input.onShareShortcut]
 *   Called when Cmd+Shift+S fires. The route's `goto()` lives here;
 *   keeps the keymap helper agnostic to entity type and SvelteKit
 *   internals.
 * @returns {() => void} cleanup
 */
export function bindUndoKeymap({ runtime, onShareShortcut }) {
    /** @param {KeyboardEvent} event */
    function handler(event) {
        const t = event.target;
        // Native undo wins inside editable surfaces.
        if (
            t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            (t instanceof HTMLElement && t.isContentEditable)
        ) {
            return;
        }

        const mod = event.metaKey || event.ctrlKey;
        if (!mod) return;

        // `event.key === 'z'` would also fire on dead-key / IME
        // sequences in some locales; `event.code === 'KeyZ'` is the
        // physical key. Use `key` here since modifier-prefixed
        // gestures don't go through IME.
        const key = event.key.toLowerCase();

        if (key === 'z' && !event.shiftKey) {
            event.preventDefault();
            void runtime.undo();
        } else if (key === 'z' && event.shiftKey) {
            event.preventDefault();
            void runtime.redo();
        } else if (key === 's' && event.shiftKey && onShareShortcut) {
            event.preventDefault();
            onShareShortcut();
        }
    }

    window.addEventListener('keydown', handler);
    return () => {
        window.removeEventListener('keydown', handler);
    };
}
