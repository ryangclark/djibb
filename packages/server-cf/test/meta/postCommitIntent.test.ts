/**
 * Post-commit intent fold (ADR 0026 series 3).
 *
 * These run in the `meta` (plain-node) project, not the workers pool: the
 * fold is pure, so the fiddliest rules in the push path — what dirties the
 * D1 snapshot, what arms the hard-delete clock, which args become an invite
 * email, what a same-owner transfer must *not* do — are assertable without
 * a DO, a binding, or a wrangler login. That is the point of the carve
 * (ADR 0015 Amendment 5: real logic that never needed a real binding).
 */

import { describe, expect, it } from 'vitest';
import {
    emptyPostCommitIntent,
    foldCommittedMutation,
    invitationFlags,
    workspaceFlags,
    type CommittedMutation,
    type PostCommitIntent,
} from '../../src/list/postCommit';

const WORKSPACE = 'w/ws-1';
const LIST = 'l/list-1';

/** Fold a whole push, as `_handlePush` does for its committed mutations. */
function foldAll(
    mutations: CommittedMutation[],
    entityId: string
): PostCommitIntent {
    return mutations.reduce(
        (intent, m) => foldCommittedMutation(intent, m, entityId),
        emptyPostCommitIntent()
    );
}

describe('emptyPostCommitIntent', () => {
    it('is inert — a push where nothing committed triggers no tail work', () => {
        const intent = emptyPostCommitIntent();
        expect(intent).toEqual({
            entityMetadataMutated: false,
            cascadeArchiveTriggered: false,
            cascadeRestoreTriggered: false,
            harddelete: null,
            startFresh: null,
            invitationsMutated: false,
            acceptedInvites: [],
            sentInvites: [],
            transferredOwnerships: [],
        });
    });
});

describe('entity snapshot trigger (ADR 0003)', () => {
    it('is raised by a metadata mutator', () => {
        const intent = foldAll([{ name: 'renameList' }], LIST);
        expect(intent.entityMetadataMutated).toBe(true);
    });

    it('is not raised by a non-metadata mutator', () => {
        // `addItem` mutates list *content*, not entity metadata — it must
        // not cost a D1 snapshot emit on every keystroke-ish push.
        const intent = foldAll([{ name: 'addItem' }], LIST);
        expect(intent.entityMetadataMutated).toBe(false);
    });
});

describe('cascade triggers (ADR 0008)', () => {
    it('archiving a workspace triggers the cascade', () => {
        const intent = foldAll([{ name: 'archiveList' }], WORKSPACE);
        expect(intent.cascadeArchiveTriggered).toBe(true);
        expect(intent.cascadeRestoreTriggered).toBe(false);
    });

    it('archiving a plain list does NOT cascade', () => {
        // The id-prefix guard: list/template archives stay self-contained.
        const intent = foldAll([{ name: 'archiveList' }], LIST);
        expect(intent.cascadeArchiveTriggered).toBe(false);
    });

    it('unarchiving a workspace triggers the restore cascade', () => {
        const intent = foldAll([{ name: 'unarchiveList' }], WORKSPACE);
        expect(intent.cascadeRestoreTriggered).toBe(true);
    });
});

describe('hard-delete clock (ADR 0008 §10b)', () => {
    it('arms on archive, for a plain list too (no prefix guard)', () => {
        expect(foldAll([{ name: 'archiveList' }], LIST).harddelete).toBe('arm');
    });

    it('arms on the system-driven cascade variant', () => {
        expect(
            foldAll([{ name: 'cascadeArchiveList' }], LIST).harddelete
        ).toBe('arm');
    });

    it('clears on restore', () => {
        expect(foldAll([{ name: 'unarchiveList' }], LIST).harddelete).toBe(
            'clear'
        );
    });

    it('last write wins: archive-then-restore in one push ends clear', () => {
        const intent = foldAll(
            [{ name: 'archiveList' }, { name: 'unarchiveList' }],
            LIST
        );
        expect(intent.harddelete).toBe('clear');
    });

    it('last write wins: restore-then-archive in one push ends armed', () => {
        const intent = foldAll(
            [{ name: 'unarchiveList' }, { name: 'archiveList' }],
            LIST
        );
        expect(intent.harddelete).toBe('arm');
    });

    it('an unrelated mutator does not clobber an earlier transition', () => {
        // `harddeleteTransition` returns null for these — null must not
        // overwrite a live arm/clear.
        const intent = foldAll(
            [{ name: 'archiveList' }, { name: 'renameList' }],
            LIST
        );
        expect(intent.harddelete).toBe('arm');
    });
});

describe('startFresh (ADR 0011 §10c)', () => {
    it('captures the actor and display name for the replacement mint', () => {
        const intent = foldAll(
            [
                {
                    name: 'startFresh',
                    args: { accountId: 'acc-1', accountDisplayName: 'Ryan' },
                },
            ],
            WORKSPACE
        );
        expect(intent.startFresh).toEqual({
            accountId: 'acc-1',
            displayName: 'Ryan',
        });
        // startFresh also archives the workspace: it must cascade and arm.
        expect(intent.cascadeArchiveTriggered).toBe(true);
        expect(intent.harddelete).toBe('arm');
    });

    it('tolerates a missing display name', () => {
        const intent = foldAll(
            [{ name: 'startFresh', args: { accountId: 'acc-1' } }],
            WORKSPACE
        );
        expect(intent.startFresh).toEqual({
            accountId: 'acc-1',
            displayName: null,
        });
    });

    it('does not capture without an actor — nothing to mint for', () => {
        const intent = foldAll([{ name: 'startFresh', args: {} }], WORKSPACE);
        expect(intent.startFresh).toBeNull();
    });

    it('does not capture on a non-workspace entity', () => {
        const intent = foldAll(
            [{ name: 'startFresh', args: { accountId: 'acc-1' } }],
            LIST
        );
        expect(intent.startFresh).toBeNull();
    });
});

describe('invitations (ADR 0009)', () => {
    it('captures a sent invite, normalizing the identity value', () => {
        const intent = foldAll(
            [
                {
                    name: 'inviteByIdentity',
                    args: {
                        identity_kind: 'email',
                        identity_value: '  RYAN@Example.COM ',
                        accountId: 'inviter-1',
                    },
                },
            ],
            LIST
        );
        expect(intent.invitationsMutated).toBe(true);
        expect(intent.sentInvites).toEqual([
            {
                identity_kind: 'email',
                identity_value: 'ryan@example.com',
                inviter_account_id: 'inviter-1',
            },
        ]);
    });

    it('drops a malformed invite rather than failing the committed push', () => {
        const intent = foldAll(
            [
                {
                    name: 'inviteByIdentity',
                    args: {
                        identity_kind: 'carrier-pigeon',
                        identity_value: 'x',
                        accountId: 'inviter-1',
                    },
                },
            ],
            LIST
        );
        // The mutator still committed, so the reconcile flag stands...
        expect(intent.invitationsMutated).toBe(true);
        // ...but there is nothing well-formed to email.
        expect(intent.sentInvites).toEqual([]);
    });

    it('captures an acceptance (marked in D1 before the reconcile diff)', () => {
        const intent = foldAll(
            [
                {
                    name: 'acceptInvitation',
                    args: {
                        identity_kind: 'email',
                        identity_value: 'RYAN@example.com',
                    },
                },
            ],
            LIST
        );
        expect(intent.acceptedInvites).toEqual([
            { identity_kind: 'email', identity_value: 'ryan@example.com' },
        ]);
        // Acceptance changes membership metadata too.
        expect(intent.entityMetadataMutated).toBe(true);
    });

    it('revoking flags the reconcile without capturing an email', () => {
        const intent = foldAll([{ name: 'revokeInvitation' }], LIST);
        expect(intent.invitationsMutated).toBe(true);
        expect(intent.sentInvites).toEqual([]);
        expect(intent.acceptedInvites).toEqual([]);
    });

    it('accumulates multiple invites across one push', () => {
        const intent = foldAll(
            [
                {
                    name: 'inviteByIdentity',
                    args: {
                        identity_kind: 'email',
                        identity_value: 'a@example.com',
                        accountId: 'inviter-1',
                    },
                },
                {
                    name: 'inviteByIdentity',
                    args: {
                        identity_kind: 'email',
                        identity_value: 'b@example.com',
                        accountId: 'inviter-1',
                    },
                },
            ],
            LIST
        );
        expect(intent.sentInvites).toHaveLength(2);
    });
});

describe('transferOwnership (ADR 0011 §Decision C)', () => {
    it('captures a real transfer with the former owner', () => {
        const intent = foldAll(
            [
                {
                    name: 'transferOwnership',
                    args: { toAccountId: 'new-owner', accountId: 'old-owner' },
                },
            ],
            LIST
        );
        expect(intent.transferredOwnerships).toEqual([
            {
                to_account_id: 'new-owner',
                former_owner_account_id: 'old-owner',
            },
        ]);
    });

    it('does NOT capture a same-owner no-op', () => {
        // The mutator reports a clean commit even though it wrote nothing;
        // firing here would email "you're now the owner" to the account
        // that already owned it.
        const intent = foldAll(
            [
                {
                    name: 'transferOwnership',
                    args: { toAccountId: 'same', accountId: 'same' },
                },
            ],
            LIST
        );
        expect(intent.transferredOwnerships).toEqual([]);
    });
});

describe('flag projection', () => {
    it('splits one intent into the two carved tails inputs', () => {
        const intent = foldAll(
            [
                { name: 'archiveList' },
                {
                    name: 'inviteByIdentity',
                    args: {
                        identity_kind: 'email',
                        identity_value: 'a@example.com',
                        accountId: 'inviter-1',
                    },
                },
            ],
            WORKSPACE
        );

        expect(invitationFlags(intent, WORKSPACE)).toEqual({
            entityId: WORKSPACE,
            acceptedInvites: [],
            invitationsMutated: true,
            sentInvites: [
                {
                    identity_kind: 'email',
                    identity_value: 'a@example.com',
                    inviter_account_id: 'inviter-1',
                },
            ],
            transferredOwnerships: [],
        });

        expect(workspaceFlags(intent, WORKSPACE)).toEqual({
            cascadeArchiveTriggered: true,
            cascadeRestoreTriggered: false,
            harddelete: 'arm',
            startFresh: null,
            listId: WORKSPACE,
        });
    });
});

describe('purity', () => {
    it('does not mutate the intent it is given', () => {
        const before = emptyPostCommitIntent();
        const after = foldCommittedMutation(
            before,
            { name: 'archiveList' },
            WORKSPACE
        );
        expect(before.cascadeArchiveTriggered).toBe(false);
        expect(before.harddelete).toBeNull();
        expect(after.cascadeArchiveTriggered).toBe(true);
    });
});
