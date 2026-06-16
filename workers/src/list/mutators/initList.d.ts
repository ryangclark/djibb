import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    childElementRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groups: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>>;
    slot: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        personal_workspace: "personal_workspace";
        inbox: "inbox";
        seed_pool: "seed_pool";
    }>>>;
    defaultRole: z.ZodOptional<z.ZodEnum<{
        checker: "checker";
        editor: "editor";
        ownerless: "ownerless";
        restricted: "restricted";
        viewer: "viewer";
    }>>;
}, z.core.$strip>;
/**
 * Wire shape: the args object as it arrives in a Replicache mutation,
 * including envelope metadata (`accountId`, `timestamp_client`). The
 * worker parses this during init reconciliation; the DO mutator only
 * sees body args via dispatch.
 */
export declare const wireArgsSchema: z.ZodObject<{
    accountId: z.ZodNullable<z.ZodString>;
    timestamp_client: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
    listId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    childElementRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groups: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>>;
    slot: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        personal_workspace: "personal_workspace";
        inbox: "inbox";
        seed_pool: "seed_pool";
    }>>>;
    defaultRole: z.ZodOptional<z.ZodEnum<{
        checker: "checker";
        editor: "editor";
        ownerless: "ownerless";
        restricted: "restricted";
        viewer: "viewer";
    }>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;
export declare const name: "initList";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Server-side init: writes the full entity row to the DO sql. Per ADR
 * 0003 the DO is authoritative for every entity field. The worker still
 * resolves auth rules from D1 on the hot path, but D1 is now a derived
 * read index emitted by the DO post-commit, not the source of truth.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Constructive inverse: the inverse of "create the list" is
 * "archive the list." Friction-tier per ADR 0005 — list creation
 * crosses a structural threshold, so the runtime renders a confirm
 * toast on Cmd+Z (lookup table in `_shared.ts` already lists
 * `initList`). Plain `archiveList`, not unarchive — undoing a
 * creation must remove the entity, not just toggle a flag.
 */
export declare const inverse: Inverse<Args>;
