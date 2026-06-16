import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    image: z.ZodNullable<z.ZodString>;
    expected: z.ZodOptional<z.ZodObject<{
        image: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setWorkspaceImage";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: restore the prior image with a CAS guard on the
 * post-state value.
 */
export declare const inverse: Inverse<Args>;
