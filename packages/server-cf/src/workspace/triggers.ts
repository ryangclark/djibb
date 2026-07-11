/**
 * Workspace push-path trigger predicates (ADR 0008).
 *
 * A leaf module, deliberately: **it imports nothing.** These three are pure
 * string comparisons over a mutator name, and they are needed by two very
 * different callers — `workspace/cascade.ts` (which reaches D1 and the DO
 * binding) and `list/postCommit.ts` (which is a pure fold, tested in plain
 * node with no bindings at all).
 *
 * Living in `cascade.ts` would have made `postCommit` transitively import
 * `derived-index/d1.ts` → `effect/d1.ts` → `@effect/sql-d1`, dragging the
 * whole Effect/D1 graph into the plain-node `meta` project just to compare
 * three strings. The fold's purity would then be incidental — true of the
 * code, false of the import graph. Here it is structural.
 *
 * (Same motivation as `list/alarm-events.ts`, which exists to keep a shared
 * type from forcing an import cycle.)
 */

/**
 * ADR 0008 §"Trigger": a successful `archiveList` (or `startFresh`) against
 * this DO's own workspace entity is the cascade-archive trigger. The
 * id-prefix check narrows to workspace entities — list and template archives
 * stay self-contained.
 */
export function isCascadeArchiveTrigger(
    mutationName: string,
    entityId: string
): boolean {
    return (
        (mutationName === 'archiveList' || mutationName === 'startFresh') &&
        entityId.startsWith('w/')
    );
}

/**
 * ADR 0008 §"Restore": symmetric trigger. An `unarchiveList` against the
 * workspace's own id flips the dispatcher into restore mode.
 */
export function isCascadeRestoreTrigger(
    mutationName: string,
    entityId: string
): boolean {
    return mutationName === 'unarchiveList' && entityId.startsWith('w/');
}

/**
 * ADR 0008 hard-delete clock arm/clear. Mutator names are the signal: a
 * successful archive of any flavor means this DO's entity row is now
 * soft-deleted (`arm` the 30d clock); a successful restore means it's live
 * again (`clear` it). Applies to every DjibbList — workspaces, lists,
 * templates — not just workspace entities, so there is no id prefix guard
 * here. Returns `null` for mutations that don't transition the soft-delete
 * state.
 */
export function harddeleteTransition(
    mutationName: string
): 'arm' | 'clear' | null {
    if (
        mutationName === 'archiveList' ||
        mutationName === 'cascadeArchiveList' ||
        mutationName === 'startFresh'
    ) {
        return 'arm';
    }
    if (
        mutationName === 'unarchiveList' ||
        mutationName === 'cascadeRestoreList'
    ) {
        return 'clear';
    }
    return null;
}
