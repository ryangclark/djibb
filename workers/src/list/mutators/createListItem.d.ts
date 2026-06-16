import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    item: z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        name: z.ZodString;
        parent_element_ref: z.ZodString;
        references_entity_id: z.ZodNullable<z.ZodString>;
        time_created: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        time_deleted: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
        time_updated: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        type: z.ZodLiteral<"item">;
        value: z.ZodObject<{
            max_value: z.ZodOptional<z.ZodNumber>;
            min_value: z.ZodOptional<z.ZodNumber>;
            target_value: z.ZodNumber;
            unit: z.ZodString;
            value: z.ZodNumber;
        }, z.core.$strip>;
        version: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "createListItem";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Constructive inverse: archive the just-created item. The id is
 * already in `args.item`, so no `capturePreState` is needed.
 */
export declare const inverse: Inverse<Args>;
