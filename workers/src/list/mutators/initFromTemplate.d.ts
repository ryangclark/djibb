import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Init a list from a template (a "fork").
 *
 * **Scope decision (A.8, intentional):** this PR only creates the
 * destination entity row with `forked_from_id` set, the template's
 * name and description carried over via args, and an empty
 * `child_element_refs`. **It does NOT copy template contents** (items
 * and groups under the template).
 *
 * Why deferred: full content copy is a DO-to-DO operation. Three
 * candidate shapes (worker pre-fetch, client pre-fetch + inline
 * payload, mutator-internal DO RPC requiring async ServerMutator)
 * each have meaningful trade-offs that warrant a design conversation.
 * Phase A is the substrate; the copy orchestration is properly its
 * own ADR-worthy decision and is being kicked.
 *
 * Today's behavior: `initFromTemplate` produces an empty list with
 * template lineage (`forked_from_id` populated). Contents can be
 * added via subsequent `createListItem` mutations as a separate
 * orchestration. The caller (UI fork flow) is responsible for any
 * copy.
 *
 * Friction-tier per ADR 0005 — list creation crosses a structural
 * threshold; the runtime (B.2) renders a confirm toast on Cmd+Z,
 * keyed on this mutator's wire name being in
 * `FRICTION_TIER_MUTATORS` (`_shared.ts`).
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    templateId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Wire shape: as it arrives in a Replicache mutation, including
 * envelope metadata. Mirrors initList's wireArgsSchema pattern.
 */
export declare const wireArgsSchema: z.ZodObject<{
    accountId: z.ZodNullable<z.ZodString>;
    timestamp_client: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
    listId: z.ZodString;
    templateId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;
export declare const name: "initFromTemplate";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Constructive inverse: archive the just-created list. Friction-tier
 * is enforced by the runtime via `FRICTION_TIER_MUTATORS`; the
 * inverse itself is a plain archiveList — undo of a fork removes the
 * entity, redo (Cmd+Shift+Z) re-creates it.
 */
export declare const inverse: Inverse<Args>;
