import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "archiveListItem";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Soft-delete one item. Body mutator — touches the item row only,
 * not the entity row, so this is NOT in `ENTITY_METADATA_MUTATORS`.
 * Items remain in `list_elements` with `time_deleted` set; the pull
 * handler emits a `del` op against the row.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Archive/restore inverse: the mirror mutator. No `capturePreState`
 * needed — the id alone is enough to reverse.
 */
export declare const inverse: Inverse<Args>;
