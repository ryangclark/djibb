import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    cascade_source: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "cascadeArchiveList";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
/**
 * Client mutator runs on the cascading caller (the Workspace DO is
 * not a Replicache client; the synthetic clientID has no local cache).
 * Concretely no one consumes this for optimistic UI — the workspace
 * cascade fans out server-side and the child DOs' pulls propagate
 * the archive to any human clients connected to those children. We
 * still register a client mutator because the Replicache runtime
 * requires every name in the registry to have one, and we mirror the
 * `archiveList` shape so a stray local-side invocation (test fixture,
 * future replay) writes the same optimistic outcome to the cache.
 */
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
