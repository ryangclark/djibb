// Shape-contract tests for `InvitableRoleEnum` and the
// `inviteByIdentity` role gate.
//
// Invariant under test: ownership is *transferred* (via the
// `transferOwnership` mutator), never *invited*. `owner` is therefore
// excluded from the set of roles an invitation may grant. Without this
// an `admin` — who passes `inviteByIdentity`'s `OWNER_ROLES` gate —
// could invite a second `owner` and break the single-owner invariant
// (`assertSingleOwner`), an end-run around `changeMemberRole`, which
// already forbids admins from minting owners on the direct-grant path.

import { describe, it, expect } from 'vitest';

import { AccountRoleEnum, InvitableRoleEnum } from '@djibb/protocol/auth/rules';
import { argsSchema as inviteArgsSchema } from '../src/list/mutators/inviteByIdentity';

const validInviteArgs = {
    // `l/` + 21-char id body (ID_LENGTH), matching ListSchema.shape.id.
    listId: `l/${'a'.repeat(21)}`,
    identity_kind: 'email' as const,
    identity_value: 'invitee@example.com',
    role: 'admin' as const,
};

describe('InvitableRoleEnum', () => {
    it(`excludes 'owner'`, () => {
        expect(InvitableRoleEnum.safeParse('owner').success).toBe(false);
    });

    it(`is AccountRoleEnum minus 'owner'`, () => {
        const expected = AccountRoleEnum.options.filter(r => r !== 'owner');
        expect([...InvitableRoleEnum.options].sort()).toEqual(
            [...expected].sort()
        );
    });

    it(`admits the four non-owner account roles`, () => {
        for (const role of ['admin', 'editor', 'checker', 'viewer']) {
            expect(InvitableRoleEnum.safeParse(role).success).toBe(true);
        }
    });
});

describe('inviteByIdentity argsSchema', () => {
    it(`rejects an invitation granting role: 'owner'`, () => {
        const result = inviteArgsSchema.safeParse({
            ...validInviteArgs,
            role: 'owner',
        });
        expect(result.success).toBe(false);
    });

    it(`accepts an invitation granting role: 'admin'`, () => {
        const result = inviteArgsSchema.safeParse(validInviteArgs);
        expect(result.success).toBe(true);
    });
});
