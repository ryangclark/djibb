import { describe, it, expect } from 'vitest';
import { resolveRole, canRead, canEdit } from '../src/auth/resolver';
import type { AuthorizationRules } from '../src/auth/rules';

const ACCOUNT_ID = 'a/me';
const session = { account_id: ACCOUNT_ID };

function rules(overrides: Partial<AuthorizationRules> = {}): AuthorizationRules {
    return {
        authorized_accounts: {},
        default_role: 'restricted',
        set_by: 'defaults',
        ...overrides,
    };
}

describe('resolveRole', () => {
    describe('anonymous (no session)', () => {
        it('returns default_role when default is viewer', () => {
            expect(resolveRole(null, rules({ default_role: 'viewer' }), null))
                .toBe('viewer');
        });

        it('returns default_role when default is restricted', () => {
            expect(resolveRole(null, rules({ default_role: 'restricted' }), null))
                .toBe('restricted');
        });

        it('ignores authorized_accounts for anonymous', () => {
            expect(
                resolveRole(
                    null,
                    rules({
                        authorized_accounts: { [ACCOUNT_ID]: { role: 'admin' } },
                        default_role: 'viewer',
                    }),
                    null,
                ),
            ).toBe('viewer');
        });
    });

    describe('authenticated, no explicit grant, no workspace membership', () => {
        it('falls through to default_role', () => {
            expect(
                resolveRole(session, rules({ default_role: 'restricted' }), null),
            ).toBe('restricted');
        });

        it('falls through to viewer default', () => {
            expect(
                resolveRole(session, rules({ default_role: 'viewer' }), null),
            ).toBe('viewer');
        });
    });

    describe('explicit authorized_accounts entry', () => {
        it('grants role above default', () => {
            expect(
                resolveRole(
                    session,
                    rules({
                        authorized_accounts: { [ACCOUNT_ID]: { role: 'editor' } },
                        default_role: 'restricted',
                    }),
                    null,
                ),
            ).toBe('editor');
        });

        it('wins over workspace membership (grant)', () => {
            expect(
                resolveRole(
                    session,
                    rules({
                        authorized_accounts: { [ACCOUNT_ID]: { role: 'owner' } },
                    }),
                    'viewer',
                ),
            ).toBe('owner');
        });

        it('wins over workspace membership (demotion)', () => {
            // Workspace admin explicitly demoted on a sensitive entity.
            expect(
                resolveRole(
                    session,
                    rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                    'admin',
                ),
            ).toBe('viewer');
        });
    });

    describe('workspace membership pass-through', () => {
        // ADR 0011 §Step 4 retired the legacy 4-tier WorkspaceRoleEnum;
        // workspace memberships now carry an AuthorizationRole directly,
        // so the resolver pass-through is identity — no translation.
        it('owner stays owner', () => {
            expect(resolveRole(session, rules(), 'owner')).toBe('owner');
        });

        it('admin stays admin', () => {
            expect(resolveRole(session, rules(), 'admin')).toBe('admin');
        });

        it('editor stays editor', () => {
            expect(resolveRole(session, rules(), 'editor')).toBe('editor');
        });

        it('viewer stays viewer', () => {
            expect(resolveRole(session, rules(), 'viewer')).toBe('viewer');
        });

        it('overrides default_role: restricted', () => {
            expect(
                resolveRole(
                    session,
                    rules({ default_role: 'restricted' }),
                    'editor',
                ),
            ).toBe('editor');
        });
    });
});

describe('canRead', () => {
    it.each(['owner', 'admin', 'editor', 'checker', 'viewer'] as const)(
        '%s can read',
        role => expect(canRead(role)).toBe(true),
    );

    it.each(['restricted', 'ownerless'] as const)('%s cannot read', role =>
        expect(canRead(role)).toBe(false),
    );
});

describe('canEdit', () => {
    it.each(['owner', 'admin', 'editor'] as const)('%s can edit', role =>
        expect(canEdit(role)).toBe(true),
    );

    it.each(['checker', 'viewer', 'restricted', 'ownerless'] as const)(
        '%s cannot edit',
        role => expect(canEdit(role)).toBe(false),
    );
});
