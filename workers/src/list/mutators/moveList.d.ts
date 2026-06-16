import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Phase 5: move a list to another workspace. A list belongs
 * to exactly one workspace; moving it re-points its `workspace_id`,
 * which is an *access-control* change — the read-side fast path
 * (`resolveSessionRole`, `workers/src/list/fetch.ts`) folds
 * `workspace_id` into the effective role, so members of the destination
 * workspace gain workspace-derived access and members of the source
 * lose it (explicit per-entity grants are untouched).
 *
 * Authorization is split across two server layers, because the
 * synchronous DO mutator has no D1 access and can't see the target
 * workspace's membership (same constraint as the invite path):
 *
 *   - THIS mutator enforces what it can see locally: the actor holds
 *     `OWNER_ROLES` on the list (`requiredRole`), the target id is
 *     well-formed (`argsSchema`), and the target differs from the
 *     current workspace (idempotent no-op otherwise).
 *   - The push-boundary preflight (`preflightMoveList`, wired in
 *     `durable_object.ts::runMutationPreflight`) enforces the
 *     cross-entity rule with a D1 binding: the actor must be a member
 *     of the destination workspace. Non-bypassable — the client cannot
 *     skip the Worker.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    workspace_id: z.ZodString;
    expected: z.ZodOptional<z.ZodObject<{
        workspace_id: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "moveList";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: move back to the prior workspace with a CAS guard
 * on the post-state id (so a concurrent move by another admin gets a
 * `stale` outcome rather than a clobber). Returns `null` when the prior
 * `workspace_id` was null/uncaptured — the picker never offers "none",
 * so there's no valid move-back target and the action simply doesn't
 * enter the undo history.
 */
export declare const inverse: Inverse<Args>;
/**
 * Deps for `preflightMoveList`. Injected as functions (rather than a raw
 * D1 binding) so the preflight stays pure-ish: tests stub each query and
 * `runMutationPreflight` binds them once against `env.DJIBB_AUTH`. Same
 * shape convention as `preflightInviteByIdentity`'s deps.
 */
export type MovePreflightDeps = {
    /**
     * Resolve the actor's membership in the destination workspace.
     * Non-null ⇒ the actor belongs to the target. Backed by
     * `GetMembership` against the `entity_memberships` projection.
     */
    getMembership: (accountId: string, workspaceId: string) => Promise<unknown | null>;
    /**
     * Does the destination workspace entity exist at all? Lets the
     * preflight distinguish "workspace gone" (→ `gone`) from "not a
     * member of an existing workspace" (→ `auth`). Backed by
     * `GetEntityVersion`.
     */
    targetWorkspaceExists: (workspaceId: string) => Promise<boolean>;
};
export type MovePreflightInput = {
    /** From `mutation.args.accountId`. Null/empty (or not in the
     *  session) rejects as `unauthenticated_actor`. */
    actor_account_id: string | null | undefined;
    /** Destination workspace id (`mutation.args.workspace_id`). */
    target_workspace_id: string;
    /** Account ids on the caller's session; the actor must be one. */
    sessionAccountIds: readonly string[];
};
export type MovePreflightFailureReason = 'unauthenticated_actor' | 'not_target_member' | 'target_missing';
export type MovePreflightResult = {
    ok: true;
} | {
    ok: false;
    reason: MovePreflightFailureReason;
    message: string;
};
/**
 * Validate a `moveList` request before the synchronous DO mutator runs.
 * The DO is single-entity and has no synchronous D1 access during a
 * push, so the cross-entity rule — "the actor must be a member of the
 * destination workspace" — lives here, at the push boundary, with a D1
 * binding. Non-bypassable: the client can't skip the Worker.
 *
 * Returns a structured result rather than throwing; the caller maps
 * each reason onto the wire `MutationOutcomeStatus`
 * (`moveReasonToOutcomeStatus` in `durable_object.ts`) and skip-and-acks
 * the mutation so Replicache stops retrying.
 */
export declare function preflightMoveList(deps: MovePreflightDeps, input: MovePreflightInput): Promise<MovePreflightResult>;
