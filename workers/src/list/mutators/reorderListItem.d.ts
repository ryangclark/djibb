import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Reorder a list item within its current parent's
 * `child_element_refs`. Cross-parent moves go through `setItemFields`
 * (parent_element_ref) — this mutator is purely positional.
 *
 * Used by Slice F (`Cmd+↑` / `Cmd+↓`) and the runtime's coalescing
 * logic (B.3): rapid same-element reorders within a 500ms window
 * collapse into a single undo entry whose preState is the position
 * before the *first* move.
 */
export declare const argsSchema: z.ZodObject<{
    id: z.ZodString;
    toIndex: z.ZodNumber;
    expected: z.ZodOptional<z.ZodObject<{
        fromIndex: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "reorderListItem";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Snapshot the item's current index in its parent's array. The
 * inverse uses this as the target on undo; the post-state position
 * (`args.toIndex`) goes into `expected` for the CAS guard.
 */
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
