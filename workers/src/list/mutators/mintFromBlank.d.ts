import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    blankId: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    childElementRefs: z.ZodArray<z.ZodString>;
    groups: z.ZodArray<z.ZodObject<{
        child_element_refs: z.ZodArray<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        name: z.ZodString;
        parent_element_ref: z.ZodString;
        time_created: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        time_deleted: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
        time_updated: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        type: z.ZodLiteral<"group">;
        version: z.ZodNumber;
    }, z.core.$strip>>;
    items: z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Wire shape: args plus the envelope metadata Replicache crams into
 * `args`. Mirrors `initFromTemplate`'s `wireArgsSchema`.
 */
export declare const wireArgsSchema: z.ZodObject<{
    accountId: z.ZodNullable<z.ZodString>;
    timestamp_client: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
    listId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    blankId: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    childElementRefs: z.ZodArray<z.ZodString>;
    groups: z.ZodArray<z.ZodObject<{
        child_element_refs: z.ZodArray<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        name: z.ZodString;
        parent_element_ref: z.ZodString;
        time_created: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        time_deleted: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
        time_updated: z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>;
        type: z.ZodLiteral<"group">;
        version: z.ZodNumber;
    }, z.core.$strip>>;
    items: z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;
export declare const name: "mintFromBlank";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Constructive inverse: archive the just-minted List. The id is in
 * `args`, so no `capturePreState`. Friction-tier (structural create) is
 * enforced via `FRICTION_TIER_MUTATORS`, matching `initFromTemplate`.
 */
export declare const inverse: Inverse<Args>;
