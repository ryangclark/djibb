// ADR 0011 §Step 10a.3 / ADR 0008: shape-contract tests for the
// `'system'` AuthorizationRole and the SYSTEM_ROLES gate constant.
// Behavior-level tests (cascade mutator accepts `'system'`, refuses
// non-system callers) land in 10a.4 when the first cascade mutator
// is wired up; here we anchor the invariants that make the design
// safe: `'system'` is a real role value, but it's structurally
// unreachable from any session-driven path because it's excluded
// from `AccountRoleEnum`, `DefaultRoleEnum`, and the explicit-grant
// schema. SYSTEM_ROLES exposes exactly the system role for cascade
// mutators to gate on.

import { describe, it, expect } from 'vitest';

import {
    AccountRoleEnum,
    AuthorizationRoleEnum,
    AuthorizedAccountSchema,
    DefaultRoleEnum,
} from '@djibb/protocol/auth/rules';
import {
    EDIT_ROLES,
    OWNER_ROLES,
    SYSTEM_ROLES,
} from '@djibb/protocol/list/mutators/_shared';

describe(`'system' AuthorizationRole + SYSTEM_ROLES`, () => {
    it(`is a member of AuthorizationRoleEnum`, () => {
        expect(AuthorizationRoleEnum.safeParse('system').success).toBe(true);
    });

    it(`is not a member of AccountRoleEnum`, () => {
        // The roles an account can hold inside a List/Workspace's
        // `authorized_accounts` map. `'system'` isn't a thing a human
        // can be granted as.
        expect(AccountRoleEnum.safeParse('system').success).toBe(false);
    });

    it(`is not a member of DefaultRoleEnum`, () => {
        // Default-role fall-through for the anonymous/passing visitor.
        // `'system'` would be a catastrophic default; structurally
        // refuse it.
        expect(DefaultRoleEnum.safeParse('system').success).toBe(false);
    });

    it(`AuthorizedAccountSchema rejects role: 'system'`, () => {
        // The persisted rules JSON cannot carry a `'system'` grant.
        // This is the on-disk guarantee that backs the runtime
        // claim: `GetMembership`/`resolveSessionRole` cannot produce
        // `'system'` because there is no row shape that would let it.
        const result = AuthorizedAccountSchema.safeParse({ role: 'system' });
        expect(result.success).toBe(false);
    });

    it(`SYSTEM_ROLES is the singleton ['system']`, () => {
        // Cascade mutators (10a.4 onward) declare `requiredRole:
        // SYSTEM_ROLES`. Anything else in the set would be a bug.
        expect([...SYSTEM_ROLES]).toEqual(['system']);
    });

    it(`SYSTEM_ROLES is disjoint from EDIT_ROLES and OWNER_ROLES`, () => {
        // The whole point of the 'system' role is that no human
        // session role implies it, and no system caller can be
        // mistaken for a human caller. The role sets must be
        // mutually exclusive.
        for (const r of SYSTEM_ROLES) {
            expect(EDIT_ROLES.includes(r)).toBe(false);
            expect(OWNER_ROLES.includes(r)).toBe(false);
        }
        for (const r of [...EDIT_ROLES, ...OWNER_ROLES]) {
            expect(SYSTEM_ROLES.includes(r)).toBe(false);
        }
    });
});
