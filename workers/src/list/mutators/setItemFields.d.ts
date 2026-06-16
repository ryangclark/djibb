import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setItemFields";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Snapshot only the keys the inverse will need to restore — exactly
 * the keys present in `args.fields`. Reads from the Replicache cache,
 * so this is a one-line read with no server round-trip.
 */
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: the same mutator with `fields` ↔ `expected`
 * swapped. The inverse restores the captured pre-state, but only if
 * current state still matches the post-state we just wrote (the CAS
 * guard). If `preState` is missing or empty, the action wasn't
 * undoable — silent skip.
 */
export declare const inverse: Inverse<Args>;
