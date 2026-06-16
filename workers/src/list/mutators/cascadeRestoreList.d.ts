import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    cascade_source: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "cascadeRestoreList";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
/**
 * Client mutator — like `cascadeArchiveList`'s, this runs in the
 * synthetic-client context, which has no local Replicache cache that
 * a real user reads. Cosmetic optimistic-state shape for any future
 * client-side replay; the user-visible cache lives on the human's
 * clients (different DOs) and gets the restore via their pull
 * snapshot.
 */
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
