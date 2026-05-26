import { z } from 'zod';
import { AuthorizationRoleEnum } from '../auth/rules';
import type { AuthorizationRole } from '../auth/rules';
import { DatelikeToDateSchema } from '../schema';

export const WORKSPACE_ID_LENGTH = 22;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/**
 * ADR 0011 §Step 4: workspace memberships now carry an entity-level
 * `AuthorizationRole` directly. The legacy `WorkspaceRoleEnum` (`owner
 * | admin | member | viewer`) is gone. The mapping:
 *
 *   - `'owner'`  → `'owner'`   (already aligned)
 *   - `'admin'`  → `'admin'`   (already aligned)
 *   - `'member'` → `'viewer'`  (NOT `'editor'`: a workspace "member"
 *     historically meant "read access to the workspace, may be
 *     promoted on specific entities" — a viewer with explicit
 *     per-entity grants, not a workspace-wide editor)
 *   - `'viewer'` → `'viewer'`  (already aligned)
 *
 * The resolver's translation table is now an identity pass-through.
 * Membership rows themselves move off D1 to entity-level
 * `authorization_rules.authorized_accounts` in step 7; this step just
 * brings the vocabulary into alignment ahead of that move.
 *
 * The 7-tier `AuthorizationRoleEnum` is broader than what's legal for a
 * workspace member (`'restricted'` and `'ownerless'` don't make sense
 * at the membership level), but we don't enforce a narrower subset at
 * the schema level. The HTTP boundary (`PatchMemberSchema` in
 * `fetch.ts`) narrows to the valid set for the change-role surface;
 * `InvitableRoleEnum` narrows further for the invite surface.
 */
export const WorkspaceMemberSchema = z.object({
    account_id: z.string(),
    role: AuthorizationRoleEnum,
    permissions: z.array(z.string()),
    time_joined: DatelikeToDateSchema,
});
export type WorkspaceMember = z.TypeOf<typeof WorkspaceMemberSchema>;

export const WorkspaceSchema = z.object({
    id: z.string().min(3),
    // ADR 0011 §7b.2: slugs are postponed (decision held with user). The
    // entity-projection path synthesizes a stable id-derived token here
    // so existing slug-keyed reads keep returning something. The strict
    // `SLUG_PATTERN` check still gates user-supplied slugs at the HTTP
    // boundary via `CreateWorkspaceRequestSchema`/`assertSlugFormat`.
    slug: z.string().min(1),
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

export const InvitationTypeEnum = z.enum(['email', 'username', 'link']);
export type InvitationType = z.TypeOf<typeof InvitationTypeEnum>;

export const InvitationStatusEnum = z.enum([
    'pending',
    'accepted',
    'revoked',
    'expired',
]);
export type InvitationStatus = z.TypeOf<typeof InvitationStatusEnum>;

/**
 * Roles that may be granted via an invite. `'owner'` is excluded — the
 * unique principal role is mintable only via the `transferOwnership`
 * mutator (ADR 0011 §Decision C). Subset of `AuthorizationRoleEnum`.
 */
export const InvitableRoleEnum = z.enum(['admin', 'editor', 'viewer']);
export type InvitableRole = z.TypeOf<typeof InvitableRoleEnum>;

export const WorkspaceInvitationSchema = z.object({
    id: z.string(),
    workspace_id: z.string(),
    type: InvitationTypeEnum,
    target_email: z.string().nullable(),
    target_account_id: z.string().nullable(),
    role: AuthorizationRoleEnum,
    token: z.string(),
    inviter_account_id: z.string(),
    status: InvitationStatusEnum,
    max_uses: z.number().nullable(),
    use_count: z.number(),
    time_created: DatelikeToDateSchema,
    time_expires: DatelikeToDateSchema,
    time_accepted: DatelikeToDateSchema.nullable(),
});
export type WorkspaceInvitation = z.TypeOf<typeof WorkspaceInvitationSchema>;

export const CreateInvitationRequestSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('email'),
        email: z.string().email(),
        role: InvitableRoleEnum,
    }),
    z.object({
        type: z.literal('username'),
        username: z.string().min(1),
        role: InvitableRoleEnum,
    }),
    z.object({
        type: z.literal('link'),
        max_uses: z.number().int().min(1).max(500).nullable().optional(),
        role: InvitableRoleEnum,
    }),
]);
export type CreateInvitationRequest = z.TypeOf<
    typeof CreateInvitationRequestSchema
>;

/**
 * Public-safe preview shape returned from `GET /invitations/:token`.
 * No PII beyond the inviter's display name.
 */
export const InvitationPreviewSchema = z.object({
    type: InvitationTypeEnum,
    role: AuthorizationRoleEnum,
    workspace: z.object({
        slug: z.string(),
        name: z.string().nullable(),
        image: z.string().nullable(),
    }),
    inviter: z.object({
        display_name: z.string(),
    }),
    time_expires: DatelikeToDateSchema,
    status: InvitationStatusEnum,
});
export type InvitationPreview = z.TypeOf<typeof InvitationPreviewSchema>;
