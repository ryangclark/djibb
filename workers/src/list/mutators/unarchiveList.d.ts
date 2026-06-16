import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "unarchiveList";
/**
 * Symmetric to `archiveList` — same role gate. The forward
 * `archiveList` is permissive (EDIT_ROLES); restore mirrors that. A
 * separate "claim ownership" flow gates entity-level auth changes
 * (setListAuthRules), not archive/restore.
 */
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Restore a soft-deleted entity row. Pair to `archiveList`. Body
 * touches `time_deleted` on the entity row so this IS in
 * `ENTITY_METADATA_MUTATORS` — the catalog needs to re-index the
 * entity once it returns from soft-delete.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
