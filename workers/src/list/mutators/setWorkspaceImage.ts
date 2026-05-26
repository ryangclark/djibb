import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { WorkspaceEntitySchema } from '..';
import { setEntityMetaField } from '../sql';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Step 5: set or clear a workspace's avatar / cover image
 * URL. Admin-or-owner gated (mirrors legacy `UpdateWorkspace`).
 *
 * Stored under `meta.image_url` rather than as a first-class column.
 * Rationale per ADR 0011 §Step 5: presentation-y fields don't clear
 * the column-promotion bar (no catalog filter/sort/index, auth
 * doesn't care). Lives alongside future icon / theme / client-pref
 * fields in the same JSON blob.
 *
 * Image values are stored verbatim (URL string); the mutator
 * intentionally does not URL-validate. A pathological client could
 * write anything; the security model treats `meta.image_url` as
 * untrusted user content regardless.
 */
const META_IMAGE_KEY = 'image_url' as const;

export const argsSchema = z.object({
    workspaceId: WorkspaceEntitySchema.shape.id,
    image: z.string().nullable(),
    /**
     * Narrow set-family CAS pre-check. When present, the server
     * compares the current `meta.image_url` to `expected.image`;
     * mismatch silently no-ops. Forward calls don't supply
     * `expected`; undo / redo do.
     */
    expected: z
        .object({
            image: z.string().nullable(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setWorkspaceImage' as const;
export const requiredRole = OWNER_ROLES;

function readCurrentImage(
    sql: SqlStorage,
    workspaceId: string
): { found: boolean; image: string | null } {
    const rows = sql
        .exec(
            `SELECT meta FROM list_elements
             WHERE id = ?
               AND type = 'workspace'
               AND time_deleted IS NULL;`,
            workspaceId
        )
        .toArray();
    const row = rows[0];
    if (!row) return { found: false, image: null };
    const meta: Record<string, unknown> =
        row.meta && typeof row.meta === 'string'
            ? JSON.parse(row.meta as string)
            : {};
    const v = meta[META_IMAGE_KEY];
    return { found: true, image: typeof v === 'string' ? v : null };
}

export const server: ServerMutator<Args> = (
    { workspaceId, image, expected },
    { sql, nextVersion }
) => {
    if (expected !== undefined) {
        const cur = readCurrentImage(sql, workspaceId);
        if (!cur.found) return { status: 'gone' };
        if (cur.image !== expected.image) return { status: 'stale' };
    }
    const outcome = setEntityMetaField(sql, {
        entityId: workspaceId,
        entityType: 'workspace',
        key: META_IMAGE_KEY,
        value: image,
        version: nextVersion,
    });
    if (outcome === 'gone') return { status: 'gone' };
};

export const client: ClientMutator<Args> = async (
    tx,
    { workspaceId, image, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) {
        throw new NotFoundError(`workspace "${workspaceId}" not found`);
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        meta?: Record<string, unknown> | null;
    };

    const currentMeta: Record<string, unknown> = entity.meta
        ? { ...entity.meta }
        : {};
    const currentImage =
        typeof currentMeta[META_IMAGE_KEY] === 'string'
            ? (currentMeta[META_IMAGE_KEY] as string)
            : null;

    if (expected !== undefined && currentImage !== expected.image) return;

    if (image === null || image === undefined) {
        delete currentMeta[META_IMAGE_KEY];
    } else {
        currentMeta[META_IMAGE_KEY] = image;
    }
    const nextMeta =
        Object.keys(currentMeta).length === 0 ? null : currentMeta;

    const ts = timestamp_client ?? new Date();
    await tx.set(
        workspaceId,
        toStoredValue({
            ...entity,
            meta: nextMeta,
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
    const entity = raw as Record<string, unknown> & {
        meta?: Record<string, unknown> | null;
    };
    const meta = entity.meta ?? {};
    const v = (meta as Record<string, unknown>)[META_IMAGE_KEY];
    return { image: typeof v === 'string' ? v : null };
};

/**
 * Set-family inverse: restore the prior image with a CAS guard on the
 * post-state value.
 */
export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || !('image' in preState)) return null;
    return {
        name,
        args: {
            workspaceId: args.workspaceId,
            image: preState.image as string | null,
            expected: { image: args.image },
        },
    };
};
