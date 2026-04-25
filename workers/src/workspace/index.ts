import { z } from 'zod';
import { DatelikeToDateSchema } from '../schema';

export const WORKSPACE_ID_LENGTH = 22;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const WorkspaceRoleEnum = z.enum([
    'owner',
    'admin',
    'member',
    'viewer',
]);
export type WorkspaceRole = z.TypeOf<typeof WorkspaceRoleEnum>;

export const WorkspaceMemberSchema = z.object({
    account_id: z.string(),
    role: WorkspaceRoleEnum,
    permissions: z.array(z.string()),
    time_joined: DatelikeToDateSchema,
});
export type WorkspaceMember = z.TypeOf<typeof WorkspaceMemberSchema>;

export const WorkspaceSchema = z.object({
    id: z.string().min(3),
    slug: z.string().regex(SLUG_PATTERN),
    // Free text including emoji. Personal workspaces may have NULL.
    name: z.string().trim().min(1).nullable(),
    is_personal: z.boolean(),
    flags: z.string().nullable(),
    image: z.string().nullable(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
});
export type Workspace = z.TypeOf<typeof WorkspaceSchema>;

export const WorkspaceWithMembershipSchema = z.object({
    workspace: WorkspaceSchema,
    membership: WorkspaceMemberSchema,
});
export type WorkspaceWithMembership = z.TypeOf<
    typeof WorkspaceWithMembershipSchema
>;

export const CreateWorkspaceRequestSchema = z.object({
    slug: z.string().regex(SLUG_PATTERN),
    name: z.string().trim().min(1).max(100),
});
export type CreateWorkspaceRequest = z.TypeOf<
    typeof CreateWorkspaceRequestSchema
>;

export const UpdateWorkspaceRequestSchema = z.object({
    slug: z.string().regex(SLUG_PATTERN).optional(),
    name: z.string().trim().min(1).max(100).nullable().optional(),
    image: z.string().nullable().optional(),
});
export type UpdateWorkspaceRequest = z.TypeOf<
    typeof UpdateWorkspaceRequestSchema
>;
