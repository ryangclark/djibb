import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    ids: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "archiveListItems";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Bulk soft-delete. Used by keymap surfaces (D.3): `Cmd+Backspace`
 * across a multi-row selection. Each id is best-effort — missing rows
 * are silently skipped, matching the single-mutator policy.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
