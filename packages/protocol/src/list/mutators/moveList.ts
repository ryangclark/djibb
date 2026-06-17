import { z } from 'zod';

import { NotFoundError } from '@djibb/protocol/errors';
import { ListSchema } from '@djibb/protocol/list';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

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
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    /**
     * Destination workspace id. Reuses the `workspace_id` shape from
     * `ListSchema` but drops the `.nullable()` — a list always belongs
     * to exactly one workspace, so the picker never offers "none" and
     * the move target is always a concrete `w/`-prefixed id.
     */
    workspace_id: ListSchema.shape.workspace_id.unwrap(),
    /**
     * Narrow set-family CAS pre-check (ADR 0005 §"Defensive conflict
     * policy"). When present, the server compares the list's current
     * `workspace_id` to `expected.workspace_id`; a mismatch silently
     * no-ops the move. Forward calls don't supply `expected`; undo /
     * redo do.
     */
    expected: z
        .object({
            workspace_id: z.string(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'moveList' as const;
export const requiredRole = OWNER_ROLES;

export const server: ServerMutator<Args> = (
    { listId, workspace_id, expected },
    { store, nextVersion }
) => {
    const row = store.getLiveEntityCasRow(listId);
    if (!row) return { status: 'gone' };

    const current = row.workspace_id ?? null;

    if (
        expected?.workspace_id !== undefined &&
        current !== expected.workspace_id
    ) {
        return { status: 'stale' };
    }

    // Idempotent no-op: already in the target workspace.
    if (current === workspace_id) return;

    store.setEntityWorkspaceId({
        entityId: listId,
        workspace_id,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, workspace_id, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`list "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        workspace_id?: string | null;
    };

    // Optimistic CAS: if the caller specified an expected workspace and
    // the local cache disagrees, no-op locally. The server re-checks.
    if (
        expected?.workspace_id !== undefined &&
        (entity.workspace_id ?? null) !== expected.workspace_id
    ) {
        return;
    }

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            workspace_id,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (tx, { listId }) => {
    const raw = await tx.get(listId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { workspace_id: entity.workspace_id ?? null };
};

/**
 * Set-family inverse: move back to the prior workspace with a CAS guard
 * on the post-state id (so a concurrent move by another admin gets a
 * `stale` outcome rather than a clobber). Returns `null` when the prior
 * `workspace_id` was null/uncaptured — the picker never offers "none",
 * so there's no valid move-back target and the action simply doesn't
 * enter the undo history.
 */
export const inverse: Inverse<Args> = (args, preState) => {
    if (
        !preState ||
        preState.workspace_id === undefined ||
        preState.workspace_id === null
    ) {
        return null;
    }
    return {
        name,
        args: {
            listId: args.listId,
            workspace_id: preState.workspace_id as string,
            expected: { workspace_id: args.workspace_id },
        },
    };
};

// ---------- Push-boundary preflight (cross-workspace membership) ----------

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
    getMembership: (
        accountId: string,
        workspaceId: string
    ) => Promise<unknown | null>;
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

export type MovePreflightFailureReason =
    | 'unauthenticated_actor'
    | 'not_target_member'
    | 'target_missing';

export type MovePreflightResult =
    | { ok: true }
    | { ok: false; reason: MovePreflightFailureReason; message: string };

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
export async function preflightMoveList(
    deps: MovePreflightDeps,
    input: MovePreflightInput
): Promise<MovePreflightResult> {
    const actor = input.actor_account_id;
    if (!actor || !input.sessionAccountIds.includes(actor)) {
        return {
            ok: false,
            reason: 'unauthenticated_actor',
            message: 'Sign in to move a list between workspaces.',
        };
    }

    const membership = await deps.getMembership(
        actor,
        input.target_workspace_id
    );
    if (membership) return { ok: true };

    // Not a member. Distinguish a missing destination (gone) from a
    // real workspace the actor simply doesn't belong to (auth).
    const exists = await deps.targetWorkspaceExists(input.target_workspace_id);
    if (!exists) {
        return {
            ok: false,
            reason: 'target_missing',
            message: 'That workspace no longer exists.',
        };
    }
    return {
        ok: false,
        reason: 'not_target_member',
        message: 'You can only move a list into a workspace you belong to.',
    };
}
