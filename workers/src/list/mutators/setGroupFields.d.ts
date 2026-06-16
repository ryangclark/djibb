import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    id: z.ZodString;
    fields: z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        parent_element_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    expected: z.ZodOptional<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        parent_element_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setGroupFields";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
