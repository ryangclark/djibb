import { z } from 'zod';
import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import type { AuthorizationRole } from '@djibb/protocol/auth/rules';
import { DatelikeToDateSchema } from '@djibb/protocol/schema';

export const WORKSPACE_ID_LENGTH = 22;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

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
 * `fetch.ts`) narrows to the valid set for the change-role surface.
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
    // ADR 0011 §7b.5: slug is a real column on `workspace_entities`,
    // defaulting to the id suffix at create time and rename-able through
    // `setWorkspaceSlug` (in-DO preflight arbitrates uniqueness against
    // the D1 `UNIQUE(type, slug)` index). See `workers/src/list/slug.ts`.
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

// ADR 0011 §7b.4: `CreateWorkspaceRequestSchema` and
// `UpdateWorkspaceRequestSchema` (HTTP boundary schemas for the legacy
// `POST /workspace` and `PATCH /workspace/:slug` endpoints) are gone.
// Workspace create/rename/image are now Replicache mutator dispatches
// (`createWorkspace`, `renameWorkspace`, `setWorkspaceImage`) whose args
// live in `workers/src/list/mutators/{createWorkspace,renameWorkspace,setWorkspaceImage}.ts`.

// ADR 0011 §7b.3: the legacy token-based `WorkspaceInvitation` system
// (multi-type: email, username, link) was deleted. Invitations now live
// on the entity DO via ADR 0009 `pending_invites` + `inviteByIdentity`/
// `acceptInvitation` mutators. `InvitationTypeEnum`, `InvitableRoleEnum`,
// `WorkspaceInvitationSchema`, `CreateInvitationRequestSchema`,
// `InvitationPreviewSchema` are gone.
