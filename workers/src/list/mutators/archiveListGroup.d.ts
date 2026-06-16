import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "archiveListGroup";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Soft-delete one group row. Body mutator — does not touch the entity
 * row, so not in `ENTITY_METADATA_MUTATORS`. Cascade-on-archive is a
 * D.5 UI question; this mutator only flips the group row.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
