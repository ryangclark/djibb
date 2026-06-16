import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Description is free-form prose; an empty string clears it. We don't
 * model a separate "unset" state — the SQL column defaults to "" and
 * the entity schema's `description` is optional, so an empty string
 * round-trips cleanly through both.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    description: z.ZodString;
    expected: z.ZodOptional<z.ZodObject<{
        description: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setDescription";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
