import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    name: z.ZodString;
    expected: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "renameList";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: same mutator with the prior name as `name` and
 * the post-state name as `expected.name` (CAS guard against another
 * client moving the entity in the interim).
 */
export declare const inverse: Inverse<Args>;
