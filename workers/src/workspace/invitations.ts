import { customAlphabet, urlAlphabet } from 'nanoid';

import {
    BadRequestError,
    FailedPreconditionError,
    NotFoundError,
    UnauthorizedError,
    UnexpectedError,
} from '../errors';
import { GetAccountById } from '../account/service';
import { GetAccountByUsername } from '../account/username';
import {
    CreateInvitationRequest,
    InvitationPreview,
    InvitationStatus,
    InvitationType,
    InvitableRole,
    WorkspaceInvitation,
} from './index';
import { AuthorizationRoleEnum } from '../auth/rules';
import {
    GetMembership,
    GetWorkspaceById,
    GetWorkspaceBySlug,
} from './service';

const INVITATION_TOKEN_LENGTH = 22;
const INVITATION_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
const MAX_OUTSTANDING_PER_INVITER = 25;
const MAX_INVITES_PER_HOUR_PER_INVITER = 10;
const LINK_MAX_USES_CEILING = 500;

const tokenGen = customAlphabet(urlAlphabet, INVITATION_TOKEN_LENGTH);

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function shapeInvitationRow(row: any): WorkspaceInvitation {
    return {
        id: row.id,
        workspace_id: row.workspace_id,
        type: row.type as InvitationType,
        target_email: row.target_email ?? null,
        target_account_id: row.target_account_id ?? null,
        role: AuthorizationRoleEnum.parse(row.role),
        token: row.token,
        inviter_account_id: row.inviter_account_id,
        status: row.status as InvitationStatus,
        max_uses: row.max_uses ?? null,
        use_count: row.use_count,
        time_created: new Date(row.time_created * 1000),
        time_expires: new Date(row.time_expires * 1000),
        time_accepted: row.time_accepted
            ? new Date(row.time_accepted * 1000)
            : null,
    };
}

/**
 * Look an invitation up by token, returning the raw row. `null` if no
 * row matches. Does NOT check status/expiry — callers decide what to do.
 */
async function getInvitationRowByToken(
    d1: D1Database,
    token: string
): Promise<WorkspaceInvitation | null> {
    const row = await d1
        .prepare(
            `SELECT * FROM workspace_invitations WHERE token = ? LIMIT 1`
        )
        .bind(token)
        .first();
    return row ? shapeInvitationRow(row) : null;
}

async function getInvitationRowById(
    d1: D1Database,
    id: string
): Promise<WorkspaceInvitation | null> {
    const row = await d1
        .prepare(`SELECT * FROM workspace_invitations WHERE id = ? LIMIT 1`)
        .bind(id)
        .first();
    return row ? shapeInvitationRow(row) : null;
}

/**
 * Returns the effective status of an invitation, lazily transitioning
 * `pending` → `expired` if `time_expires` has passed. The DB row is
 * NOT updated here — callers that need persistence call markExpired().
 */
function effectiveStatus(inv: WorkspaceInvitation): InvitationStatus {
    if (inv.status === 'pending' && inv.time_expires.getTime() <= Date.now()) {
        return 'expired';
    }
    return inv.status;
}

async function markStatus(
    d1: D1Database,
    id: string,
    status: InvitationStatus
): Promise<void> {
    await d1
        .prepare(`UPDATE workspace_invitations SET status = ? WHERE id = ?`)
        .bind(status, id)
        .run();
}

export async function CreateInvitation(
    d1: D1Database,
    actorAccountId: string,
    workspaceSlug: string,
    body: CreateInvitationRequest
): Promise<WorkspaceInvitation> {
    const workspace = await GetWorkspaceBySlug(d1, workspaceSlug);
    if (workspace.is_personal) {
        throw new FailedPreconditionError(
            'Personal workspaces cannot have invitations.'
        );
    }
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership) throw new UnauthorizedError('Not a member.');
    if (!['owner', 'admin'].includes(membership.role)) {
        throw new UnauthorizedError(
            'Only owners and admins can create invitations.'
        );
    }

    // Email-type invites require the inviter's email to be verified.
    // For Google OAuth accounts this is set on signup.
    if (body.type === 'email') {
        const actor = await GetAccountById(d1, actorAccountId);
        if (!actor?.email_verified) {
            throw new FailedPreconditionError(
                'Your email must be verified to send email invitations.'
            );
        }
    }

    // Per-inviter rate limit (last hour) and outstanding cap, scoped to
    // this workspace. Both queries hit the
    // (inviter_account_id, workspace_id, time_created) composite index.
    const recentCutoff = nowSec() - 60 * 60;
    const counts = await d1
        .prepare(
            `SELECT
                SUM(CASE WHEN time_created > ? THEN 1 ELSE 0 END) AS recent,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS outstanding
             FROM workspace_invitations
             WHERE inviter_account_id = ? AND workspace_id = ?`
        )
        .bind(recentCutoff, actorAccountId, workspace.id)
        .first<{ recent: number | null; outstanding: number | null }>();

    if ((counts?.recent ?? 0) >= MAX_INVITES_PER_HOUR_PER_INVITER) {
        throw new FailedPreconditionError(
            `Rate limit: max ${MAX_INVITES_PER_HOUR_PER_INVITER} invites per hour.`
        );
    }
    if ((counts?.outstanding ?? 0) >= MAX_OUTSTANDING_PER_INVITER) {
        throw new FailedPreconditionError(
            `Outstanding-invite cap reached (${MAX_OUTSTANDING_PER_INVITER}). Revoke some pending invites first.`
        );
    }

    // Invitation IDs use a literal `inv/` prefix; they don't appear in
    // URLs (the token does), so they don't need to be in `IdTypes`.
    const invitationId = `inv/${tokenGen()}`;
    const token = tokenGen();
    const created = nowSec();
    const expires = created + INVITATION_EXPIRES_SECONDS;

    let target_email: string | null = null;
    let target_account_id: string | null = null;
    let max_uses: number | null = null;

    if (body.type === 'email') {
        target_email = body.email.trim().toLowerCase();
    } else if (body.type === 'username') {
        const found = await GetAccountByUsername(d1, body.username);
        if (!found) {
            throw new BadRequestError(
                `No account found for username "${body.username}".`
            );
        }
        target_account_id = found.id;
        // Block self-invitation.
        if (target_account_id === actorAccountId) {
            throw new BadRequestError('You cannot invite yourself.');
        }
        // Block inviting an existing member.
        const existing = await GetMembership(d1, target_account_id, workspace.id);
        if (existing) {
            throw new FailedPreconditionError(
                'That account is already a member.'
            );
        }
    } else {
        // link
        if (body.max_uses != null) {
            if (body.max_uses < 1) {
                throw new BadRequestError('max_uses must be >= 1.');
            }
            if (body.max_uses > LINK_MAX_USES_CEILING) {
                throw new BadRequestError(
                    `max_uses cannot exceed ${LINK_MAX_USES_CEILING}.`
                );
            }
            max_uses = body.max_uses;
        }
    }

    try {
        await d1
            .prepare(
                `INSERT INTO workspace_invitations (
                    id, workspace_id, type, target_email, target_account_id,
                    role, token, inviter_account_id, status, max_uses,
                    use_count, time_created, time_expires
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`
            )
            .bind(
                invitationId,
                workspace.id,
                body.type,
                target_email,
                target_account_id,
                body.role,
                token,
                actorAccountId,
                max_uses,
                created,
                expires
            )
            .run();
    } catch (err: any) {
        console.error('CreateInvitation insert error:', err);
        throw new UnexpectedError();
    }

    return {
        id: invitationId,
        workspace_id: workspace.id,
        type: body.type,
        target_email,
        target_account_id,
        role: body.role,
        token,
        inviter_account_id: actorAccountId,
        status: 'pending',
        max_uses,
        use_count: 0,
        time_created: new Date(created * 1000),
        time_expires: new Date(expires * 1000),
        time_accepted: null,
    };
}

export async function ListInvitations(
    d1: D1Database,
    actorAccountId: string,
    workspaceSlug: string
): Promise<WorkspaceInvitation[]> {
    const workspace = await GetWorkspaceBySlug(d1, workspaceSlug);
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new UnauthorizedError(
            'Only owners and admins can list invitations.'
        );
    }

    const result = await d1
        .prepare(
            `SELECT * FROM workspace_invitations
             WHERE workspace_id = ? AND status = 'pending'
             ORDER BY time_created DESC`
        )
        .bind(workspace.id)
        .all();
    if (!result.success) throw new UnexpectedError();
    return (result.results as any[])
        .map(shapeInvitationRow)
        // Lazily filter expired so the list reflects effective status.
        .filter(inv => effectiveStatus(inv) === 'pending');
}

export async function RevokeInvitation(
    d1: D1Database,
    actorAccountId: string,
    workspaceSlug: string,
    invitationId: string
): Promise<void> {
    const workspace = await GetWorkspaceBySlug(d1, workspaceSlug);
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw new UnauthorizedError(
            'Only owners and admins can revoke invitations.'
        );
    }
    const inv = await getInvitationRowById(d1, invitationId);
    if (!inv || inv.workspace_id !== workspace.id) {
        throw new NotFoundError('Invitation not found.');
    }
    if (inv.status !== 'pending') return; // idempotent
    await markStatus(d1, inv.id, 'revoked');
}

export async function GetInvitationPreview(
    d1: D1Database,
    token: string
): Promise<InvitationPreview> {
    const inv = await getInvitationRowByToken(d1, token);
    if (!inv) throw new NotFoundError('Invitation not found.');

    // Auto-mark expired so subsequent reads see the right status.
    let status = inv.status;
    if (effectiveStatus(inv) === 'expired' && inv.status === 'pending') {
        await markStatus(d1, inv.id, 'expired');
        status = 'expired';
    }

    const workspace = await GetWorkspaceById(d1, inv.workspace_id);
    const inviter = await GetAccountById(d1, inv.inviter_account_id);

    return {
        type: inv.type,
        role: inv.role,
        workspace: {
            slug: workspace.slug,
            name: workspace.name,
            image: workspace.image,
        },
        inviter: {
            display_name: inviter?.display_name ?? 'Someone',
        },
        time_expires: inv.time_expires,
        status,
    };
}

export interface AcceptInvitationResult {
    workspace_id: string;
    workspace_slug: string;
    role: InvitableRole | 'owner';
    /** True if a new AccountWorkspace row was created; false if the
     *  account was already a member (idempotent re-accept). */
    membership_created: boolean;
}

/**
 * Accept an invitation with a specific account from the actor's session.
 *
 * Idempotency:
 * - If the account is already a member of the workspace, this returns
 *   success with `membership_created: false` and does not bump
 *   `use_count` or change `status`.
 * - If the invitation is single-use (`email`/`username`) and was already
 *   accepted, the call fails (FailedPrecondition) — the existing
 *   membership is the canonical state.
 *
 * Email-type auto-match: if the invitation's `target_email` matches the
 * account's verified email, accept proceeds. Otherwise rejected (caller
 * should pick a different account).
 */
export async function AcceptInvitation(
    d1: D1Database,
    actorAccountId: string,
    token: string
): Promise<AcceptInvitationResult> {
    const inv = await getInvitationRowByToken(d1, token);
    if (!inv) throw new NotFoundError('Invitation not found.');

    if (effectiveStatus(inv) === 'expired') {
        if (inv.status === 'pending') await markStatus(d1, inv.id, 'expired');
        throw new FailedPreconditionError('Invitation has expired.');
    }
    if (inv.status === 'revoked') {
        throw new FailedPreconditionError('Invitation has been revoked.');
    }
    if (inv.status === 'accepted') {
        throw new FailedPreconditionError(
            'Invitation has already been used.'
        );
    }

    const account = await GetAccountById(d1, actorAccountId);
    if (!account) throw new NotFoundError('Account not found.');
    const workspace = await GetWorkspaceById(d1, inv.workspace_id);

    // Type-specific target validation.
    if (inv.type === 'username') {
        if (inv.target_account_id !== actorAccountId) {
            throw new UnauthorizedError(
                'This invitation is for a different account.'
            );
        }
    } else if (inv.type === 'email') {
        if (
            !account.email ||
            !account.email_verified ||
            account.email.toLowerCase() !== (inv.target_email ?? '').toLowerCase()
        ) {
            throw new UnauthorizedError(
                'This invitation is for a different (verified) email address.'
            );
        }
    } else if (inv.type === 'link') {
        if (inv.max_uses != null && inv.use_count >= inv.max_uses) {
            // Belt-and-suspenders; status should already be 'expired' or
            // we should mark it accepted/exhausted.
            throw new FailedPreconditionError(
                'This invitation link has reached its maximum uses.'
            );
        }
    }

    // Idempotent: if already a member, do nothing.
    const existing = await GetMembership(d1, actorAccountId, workspace.id);
    if (existing) {
        return {
            workspace_id: workspace.id,
            workspace_slug: workspace.slug,
            role: existing.role as AcceptInvitationResult['role'],
            membership_created: false,
        };
    }

    // Insert membership + bump invitation state in one batch.
    const joinedAt = nowSec();
    const insertMembership = d1
        .prepare(
            `INSERT INTO AccountWorkspace
                (account_id, workspace_id, role, permissions, time_joined)
             VALUES (?, ?, ?, NULL, ?)`
        )
        .bind(actorAccountId, workspace.id, inv.role, joinedAt);

    let bumpInvitation: D1PreparedStatement;
    if (inv.type === 'link') {
        const newUseCount = inv.use_count + 1;
        const exhausted = inv.max_uses != null && newUseCount >= inv.max_uses;
        bumpInvitation = d1
            .prepare(
                `UPDATE workspace_invitations
                 SET use_count = ?, status = ?, time_accepted = COALESCE(time_accepted, ?)
                 WHERE id = ?`
            )
            .bind(
                newUseCount,
                exhausted ? 'accepted' : 'pending',
                joinedAt,
                inv.id
            );
    } else {
        // Single-use: mark accepted and pin time_accepted.
        bumpInvitation = d1
            .prepare(
                `UPDATE workspace_invitations
                 SET use_count = use_count + 1, status = 'accepted', time_accepted = ?
                 WHERE id = ?`
            )
            .bind(joinedAt, inv.id);
    }

    try {
        await d1.batch([insertMembership, bumpInvitation]);
    } catch (err: any) {
        console.error('AcceptInvitation batch error:', err);
        throw new UnexpectedError();
    }

    return {
        workspace_id: workspace.id,
        workspace_slug: workspace.slug,
        role: inv.role,
        membership_created: true,
    };
}
