import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { WorkspaceEntitySchema } from '@djibb/protocol/list';
import { renameWorkspaceEntity } from '../sql';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Step 5: rename a workspace. Symmetric to `renameList` but
 * tighter on role — only admins and owners may rename a workspace,
 * matching the legacy `UpdateWorkspace` HTTP behaviour. The SQL helper
 * is type-narrowed to `type = 'workspace'` rows, so a `renameWorkspace`
 * routed at a list/template id surfaces as `NotFoundError` (defensive,
 * not security-critical — the role gate is the real boundary).
 */
export const argsSchema = z.object({
    workspaceId: WorkspaceEntitySchema.shape.id,
    name: z.string().trim().min(1).max(100),
    /**
     * Narrow set-family CAS pre-check. When present, the server
     * compares the current entity name to `expected.name`; mismatch
     * silently no-ops the mutation. Forward calls don't supply
     * `expected`; undo / redo do. ADR 0005 §"Defensive conflict
     * policy."
     */
    expected: z
        .object({
            name: z.string(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'renameWorkspace' as const;
export const requiredRole = OWNER_ROLES;

export const server: ServerMutator<Args> = (
    { workspaceId, name: newName, expected },
    { sql, nextVersion }
) => {
    if (expected?.name !== undefined) {
        const rows = sql
            .exec(
                `SELECT name FROM list_elements
                 WHERE id = ?
                   AND type = 'workspace'
                   AND time_deleted IS NULL;`,
                workspaceId
            )
            .toArray();
        const row = rows[0];
        if (!row) return { status: 'gone' };
        if (row.name !== expected.name) return { status: 'stale' };
    }
    renameWorkspaceEntity(sql, {
        workspaceId,
        name: newName,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { workspaceId, name: newName, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) {
        throw new NotFoundError(`workspace "${workspaceId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    if (expected?.name !== undefined && entity.name !== expected.name) return;

    const ts = timestamp_client ?? new Date();
    await tx.set(
        workspaceId,
        toStoredValue({
            ...entity,
            name: newName,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { workspaceId }
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { name: entity.name };
};

/**
 * Set-family inverse: same mutator with the prior name as `name` and
 * the post-state name as `expected.name` (CAS guard against another
 * admin moving the workspace in the interim).
 */
export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.name === undefined) return null;
    return {
        name,
        args: {
            workspaceId: args.workspaceId,
            name: preState.name,
            expected: { name: args.name },
        },
    };
};
