import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "archiveList";
/**
 * Permissive on purpose — checker and editor can already mutate every
 * piece of list state; archiving is "this is done, hide it" which fits
 * the same trust model as toggling items off. If the project later
 * tightens this to OWNER_ROLES, the catalog and pull machinery don't
 * need to change; only the dispatch gate does.
 */
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Soft-delete the entity row. The pull handler emits a `del` op for
 * any element with `time_deleted` set, so the entity disappears from
 * connected clients on the next pull. The catalog read index also
 * filters soft-deleted rows, so the post-commit emit removes the
 * entity from picker results.
 *
 * Items under the entity are not touched. Cheap to leave them; an
 * eventual unarchive flow restores the entity row and the items are
 * still there. Hard delete + cascade is a separate, larger feature.
 */
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Archive/restore inverse: pair is `unarchiveList`. ADR 0005 also
 * flags entity-level archive as friction-tier when it crosses the
 * structural-threshold question (deletes that change list visibility
 * for other accounts) — Cmd+Z still works, but the toast surfaces a
 * confirm prompt. The friction lookup happens in the runtime (B.2);
 * this file just declares the inverse pair.
 */
export declare const inverse: Inverse<Args>;
