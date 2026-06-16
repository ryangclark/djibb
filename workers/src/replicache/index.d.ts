import type { WriteTransaction } from 'replicache';
import { z } from 'zod';
export declare const MutationSchema: z.ZodObject<{
    clientID: z.ZodString;
    id: z.ZodNumber;
    name: z.ZodString;
    args: z.ZodAny;
}, z.core.$strip>;
/**
 * Request body for a Replicache Pull Request.
 *
 * Cookie shape (ADR 0009 Slice 2): a small object
 * `{v: number, r: role|null}` whose `r` lets the pull handler detect
 * role transitions across pulls (demotion ⇒ emit `del` ops for
 * keyspaces the new role can't see). `null` is the canonical
 * fresh-pull form. The handler validates via `parsePullCookie` in
 * `replicache/keyspaces`.
 */
export declare const ReplicachePullRequestSchema: z.ZodObject<{
    pullVersion: z.ZodLiteral<1>;
    profileID: z.ZodString;
    clientGroupID: z.ZodString;
    cookie: z.ZodUnion<readonly [z.ZodObject<{}, z.core.$loose>, z.ZodNull]>;
    schemaVersion: z.ZodString;
}, z.core.$strip>;
export type ReplicachePullRequest = z.TypeOf<typeof ReplicachePullRequestSchema>;
export declare const PushRequestSchema: z.ZodObject<{
    profileID: z.ZodString;
    clientGroupID: z.ZodString;
    mutations: z.ZodArray<z.ZodObject<{
        clientID: z.ZodString;
        id: z.ZodNumber;
        name: z.ZodString;
        args: z.ZodAny;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ReplicacheClientSchema: z.ZodObject<{
    id: z.ZodString;
    lastMutationId: z.ZodNumber;
    lastModifiedVersion: z.ZodNumber;
}, z.core.$strip>;
export type ReplicacheClient = {
    id: string;
    lastMutationID: number;
    lastModifiedVersion: number;
};
export declare const ReplicacheClientGroupSchema: z.ZodObject<{
    accountId: z.ZodNullable<z.ZodString>;
    clients: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        lastMutationId: z.ZodNumber;
        lastModifiedVersion: z.ZodNumber;
    }, z.core.$strip>>;
    id: z.ZodString;
}, z.core.$strip>;
export type ReplicacheClientGroup = z.infer<typeof ReplicacheClientGroupSchema>;
export type SimpleWriteTransaction = Pick<WriteTransaction, 'reason' | 'set' | 'del' | 'location' | 'get' | 'isEmpty'>;
