/**
 * Post-commit intent: what the push's committed mutations imply for the
 * tail (ADR 0026 series 3; the host half of the Effect plan's Phase 4).
 *
 * ADR 0026 series 1 and 2 carved the post-commit tail's *execution* out of
 * `_handlePush` into `workspace/cascade.ts` and `list/notifications.ts`,
 * each of which takes a flags object describing what the push did. But the
 * *accumulation* of those flags stayed inline in the DO's mutation loop as
 * nine mutable `let`s and ~140 lines of arg-fishing interleaved with the
 * loop's own bookkeeping — the last hand-rolled orchestration in the DO.
 *
 * This module is that accumulation, as a pure fold: committed mutations in,
 * one `PostCommitIntent` out, two typed flag objects at the door. The DO's
 * loop keeps its Replicache concerns (mutation ids, versions, acks) and
 * hands each *committed* mutation here.
 *
 * Everything in here is pure — no SQL, no bindings, no clock. That is the
 * point: the trigger rules (which mutators dirty the entity snapshot, what
 * arms the hard-delete clock, which args become an invite email) are the
 * fiddliest, most order-sensitive logic in the push path, and they are now
 * assertable in plain node without the workers pool (ADR 0015 Amendment 5's
 * distinction: this is real logic that never needed a real binding).
 */

import type { InvitationPostCommitFlags } from './notifications';
import {
    harddeleteTransition,
    isCascadeArchiveTrigger,
    isCascadeRestoreTrigger,
    type WorkspacePostCommitFlags,
} from '../workspace/cascade';
import {
    InvitationIdentityKindEnum,
    normalizeIdentityValue,
    type InvitationIdentityKind,
} from './invitations';

/**
 * Mutators that touch entity-level metadata and therefore dirty the D1
 * read-index snapshot (ADR 0003). A push containing any of these emits a
 * fresh entity snapshot post-commit.
 */
const ENTITY_METADATA_MUTATORS: ReadonlySet<string> = new Set([
    'acceptInvitation',
    'archiveList',
    'cascadeArchiveList',
    'cascadeRestoreList',
    'changeMemberRole',
    'claimEntity',
    'createWorkspace',
    'initFromTemplate',
    'initList',
    'leaveMember',
    'mintFromBlank',
    'moveList',
    'removeMember',
    'renameList',
    'renameWorkspace',
    'setDescription',
    'setListAuthRules',
    'setWorkspaceImage',
    'setWorkspaceSlug',
    'startFresh',
    'transferOwnership',
    'unarchiveList',
]);

/**
 * Mutators that touch the DO's `pending_invites` table, and so require the
 * post-commit reconcile against `entity_invitations_index` (ADR 0009).
 */
const INVITATION_MUTATORS: ReadonlySet<string> = new Set([
    'acceptInvitation',
    'inviteByIdentity',
    'revokeInvitation',
]);

/**
 * The minimum a fold needs off the wire. Structurally satisfied by
 * Replicache's `MutationV1`, but stated locally so this module stays free
 * of the replicache import (and testable from a plain object literal).
 */
export interface CommittedMutation {
    name: string;
    args?: unknown;
}

/**
 * Everything the push's committed mutations imply for the post-commit
 * tail. Accumulated across the mutation loop, then split into the two
 * carved tails' flag objects by `invitationFlags` / `workspaceFlags`.
 */
export interface PostCommitIntent {
    /** Any mutator in `ENTITY_METADATA_MUTATORS` committed (ADR 0003). */
    entityMetadataMutated: boolean;
    /** An `archiveList`/`startFresh` hit this DO's own workspace (ADR 0008). */
    cascadeArchiveTriggered: boolean;
    /** An `unarchiveList` hit this DO's own workspace (ADR 0008 §Restore). */
    cascadeRestoreTriggered: boolean;
    /**
     * Hard-delete clock transition for this DO's own row (ADR 0008 §10b).
     * Last write wins across the push: a push containing both an archive
     * and an unarchive must reflect the final state, not the first.
     */
    harddelete: 'arm' | 'clear' | null;
    /**
     * Actor of a `startFresh` on this DO's personal workspace, carrying the
     * display name the post-commit mint needs to format `<name>'s space`.
     * Last write wins, matching `harddelete`.
     */
    startFresh: { accountId: string; displayName: string | null } | null;
    /** Any mutator in `INVITATION_MUTATORS` committed (ADR 0009). */
    invitationsMutated: boolean;
    /**
     * Identities whose pending_invite was accepted this push. Marked
     * 'accepted' in D1 *before* the reconciler's diff runs, so the
     * "missing in DO ⇒ revoked" rule doesn't downgrade them.
     */
    acceptedInvites: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
    }>;
    /** `inviteByIdentity` sends, drained post-commit into emails. */
    sentInvites: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
        inviter_account_id: string;
    }>;
    /** `transferOwnership` moves that actually changed the principal. */
    transferredOwnerships: ReadonlyArray<{
        to_account_id: string;
        former_owner_account_id: string | null;
    }>;
}

/** The identity of the fold — a push in which nothing committed. */
export function emptyPostCommitIntent(): PostCommitIntent {
    return {
        entityMetadataMutated: false,
        cascadeArchiveTriggered: false,
        cascadeRestoreTriggered: false,
        harddelete: null,
        startFresh: null,
        invitationsMutated: false,
        acceptedInvites: [],
        sentInvites: [],
        transferredOwnerships: [],
    };
}

/**
 * Fold one *committed* mutation into the intent.
 *
 * Only call this when the mutation actually mutated (`didMutate`): a
 * skipped, stale, or unauthorized mutation must not fire an email or arm a
 * clock. That gate is the caller's — this module trusts it, exactly as the
 * inline code it replaces did.
 *
 * Args are read off the wire rather than re-read from SQL: by the time a
 * mutation commits, the mutator has already parsed and role-gated them.
 * The zod `safeParse` on identity kind keeps the cast honest, and each
 * capture is individually guarded — a malformed arg drops that one capture
 * rather than failing the (already committed) push.
 */
export function foldCommittedMutation(
    intent: PostCommitIntent,
    mutation: CommittedMutation,
    entityId: string
): PostCommitIntent {
    const name = mutation.name;
    const args = (mutation.args ?? {}) as Record<string, unknown>;
    const next: PostCommitIntent = { ...intent };

    if (ENTITY_METADATA_MUTATORS.has(name)) {
        next.entityMetadataMutated = true;
    }
    if (INVITATION_MUTATORS.has(name)) {
        next.invitationsMutated = true;
    }
    if (isCascadeArchiveTrigger(name, entityId)) {
        next.cascadeArchiveTriggered = true;
    }
    if (isCascadeRestoreTrigger(name, entityId)) {
        next.cascadeRestoreTriggered = true;
    }

    // Last write wins: `harddeleteTransition` returns null for mutators
    // that don't move the soft-delete state, and those must not clobber an
    // earlier arm/clear in the same push.
    const transition = harddeleteTransition(name);
    if (transition !== null) {
        next.harddelete = transition;
    }

    // `startFresh` on this DO's own personal workspace: capture the actor
    // so the post-commit tail can mint their replacement workspace. The
    // mint can't run in the mutator — it needs a cross-DO synth push, which
    // the synchronous server-mutator surface cannot do (ADR 0011 §10c).
    if (name === 'startFresh' && entityId.startsWith('w/')) {
        const actor = args.accountId;
        const displayName = args.accountDisplayName;
        if (typeof actor === 'string') {
            next.startFresh = {
                accountId: actor,
                displayName:
                    typeof displayName === 'string' ? displayName : null,
            };
        }
    }

    if (name === 'inviteByIdentity') {
        const kind = InvitationIdentityKindEnum.safeParse(args.identity_kind);
        const value = args.identity_value;
        const inviter = args.accountId;
        if (
            kind.success &&
            typeof value === 'string' &&
            typeof inviter === 'string'
        ) {
            next.sentInvites = [
                ...intent.sentInvites,
                {
                    identity_kind: kind.data,
                    identity_value: normalizeIdentityValue(kind.data, value),
                    inviter_account_id: inviter,
                },
            ];
        }
    }

    if (name === 'acceptInvitation') {
        const kind = InvitationIdentityKindEnum.safeParse(args.identity_kind);
        const value = args.identity_value;
        if (kind.success && typeof value === 'string') {
            next.acceptedInvites = [
                ...intent.acceptedInvites,
                {
                    identity_kind: kind.data,
                    identity_value: normalizeIdentityValue(kind.data, value),
                },
            ];
        }
    }

    if (name === 'transferOwnership') {
        // `accountId` is the actor, and the mutator proved it equals the
        // current owner (else the mutation would be `stale`), so it is the
        // former owner. Same-owner no-ops are filtered here rather than in
        // the tail: the mutator returns without writing but still reports a
        // clean commit, and we must not email "you're now the owner" to the
        // account that already owned it.
        const to = args.toAccountId;
        const actor = args.accountId;
        if (typeof to === 'string' && to !== actor) {
            next.transferredOwnerships = [
                ...intent.transferredOwnerships,
                {
                    to_account_id: to,
                    former_owner_account_id:
                        typeof actor === 'string' ? actor : null,
                },
            ];
        }
    }

    return next;
}

/** Project the intent onto `applyInvitationPostCommit`'s flags (ADR 0009). */
export function invitationFlags(
    intent: PostCommitIntent,
    entityId: string
): InvitationPostCommitFlags {
    return {
        entityId,
        acceptedInvites: intent.acceptedInvites,
        invitationsMutated: intent.invitationsMutated,
        sentInvites: intent.sentInvites,
        transferredOwnerships: intent.transferredOwnerships,
    };
}

/** Project the intent onto `applyWorkspacePostCommit`'s flags (ADR 0008). */
export function workspaceFlags(
    intent: PostCommitIntent,
    listId: string
): WorkspacePostCommitFlags {
    return {
        cascadeArchiveTriggered: intent.cascadeArchiveTriggered,
        cascadeRestoreTriggered: intent.cascadeRestoreTriggered,
        harddelete: intent.harddelete,
        startFresh: intent.startFresh,
        listId,
    };
}
