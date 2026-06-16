import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Step 5: rename a workspace. Symmetric to `renameList` but
 * tighter on role — only admins and owners may rename a workspace,
 * matching the legacy `UpdateWorkspace` HTTP behaviour. The SQL helper
 * is type-narrowed to `type = 'workspace'` rows, so a `renameWorkspace`
 * routed at a list/template id surfaces as `NotFoundError` (defensive,
 * not security-critical — the role gate is the real boundary).
 */
export declare const argsSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    name: z.ZodString;
    expected: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "renameWorkspace";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: same mutator with the prior name as `name` and
 * the post-state name as `expected.name` (CAS guard against another
 * admin moving the workspace in the interim).
 */
export declare const inverse: Inverse<Args>;
