import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        fields: z.ZodObject<{
            description: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            parent_element_ref: z.ZodOptional<z.ZodString>;
            references_entity_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            value: z.ZodOptional<z.ZodObject<{
                max_value: z.ZodOptional<z.ZodNumber>;
                min_value: z.ZodOptional<z.ZodNumber>;
                target_value: z.ZodNumber;
                unit: z.ZodString;
                value: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strict>;
        expected: z.ZodOptional<z.ZodObject<{
            description: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            parent_element_ref: z.ZodOptional<z.ZodString>;
            references_entity_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            value: z.ZodOptional<z.ZodObject<{
                max_value: z.ZodOptional<z.ZodNumber>;
                min_value: z.ZodOptional<z.ZodNumber>;
                target_value: z.ZodNumber;
                unit: z.ZodString;
                value: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strict>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setItemsAtomic";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Snapshots per-entry pre-state. Threaded through `inverse` as
 * `{ items: [{ id, pre }] }`. `pre` contains only the keys present in
 * that entry's `fields`.
 */
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
