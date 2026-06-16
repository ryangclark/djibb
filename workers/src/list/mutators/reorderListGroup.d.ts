import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Reorder a group within its current parent's `child_element_refs`.
 * Symmetric to `reorderListItem`. Cross-parent group moves go through
 * `setGroupFields` (parent_element_ref).
 */
export declare const argsSchema: z.ZodObject<{
    id: z.ZodString;
    toIndex: z.ZodNumber;
    expected: z.ZodOptional<z.ZodObject<{
        fromIndex: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "reorderListGroup";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
