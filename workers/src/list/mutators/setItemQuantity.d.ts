import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    itemId: z.ZodString;
    quantity: z.ZodObject<{
        max_value: z.ZodOptional<z.ZodNumber>;
        min_value: z.ZodOptional<z.ZodNumber>;
        target_value: z.ZodNumber;
        unit: z.ZodString;
        value: z.ZodNumber;
    }, z.core.$strip>;
    expected: z.ZodOptional<z.ZodObject<{
        quantity: z.ZodObject<{
            max_value: z.ZodOptional<z.ZodNumber>;
            min_value: z.ZodOptional<z.ZodNumber>;
            target_value: z.ZodNumber;
            unit: z.ZodString;
            value: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setItemQuantity";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
