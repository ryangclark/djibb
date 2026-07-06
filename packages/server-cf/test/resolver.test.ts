import { describe, it, expect } from 'vitest';
import {
    canEdit,
    canRead,
    resolvePreInitRole,
    resolveRequestRole,
    type RoleResolutionDeps,
} from '../src/auth/resolver';
import { UnauthorizedError } from '../src/auth/errors';
import type { RequestPrincipal } from '../src/auth/principal';
import type { Account } from '@djibb/protocol/account';
import type {
    AuthorizationRole,
    AuthorizationRules,
} from '@djibb/protocol/auth/rules';

const ACCOUNT_ID = 'a/me';
const OTHER_ACCOUNT_ID = 'a/other';
const WORKSPACE_ID = 'workspace/w1';

function account(id: string): Account {
    return {
        id,
        display_name: id,
        email: null,
        email_verified: false,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'client',
        user_name: null,
        time_created: new Date(0),
        time_deleted: null,
        time_updated: new Date(0),
    };
}

function sessionPrincipal(...accountIds: string[]): RequestPrincipal {
    return {
        kind: 'session',
        accounts: accountIds.map(account),
        sessionId: 's/test',
    };
}

const ANONYMOUS: RequestPrincipal = { kind: 'anonymous' };

/**
 * Stub membership lookup: `memberships` maps `${accountId}:${workspaceId}`
 * to a role. Everything else is a non-member.
 */
function deps(
    memberships: Record<string, AuthorizationRole> = {},
): RoleResolutionDeps {
    return {
        getMembershipRole: async (accountId, workspaceId) =>
            memberships[`${accountId}:${workspaceId}`] ?? null,
    };
}

function rules(overrides: Partial<AuthorizationRules> = {}): AuthorizationRules {
    return {
        authorized_accounts: {},
        default_role: 'restricted',
        set_by: 'defaults',
        ...overrides,
    };
}

function resolve(input: {
    principal?: RequestPrincipal;
    activeAccountId?: string | null;
    rules?: AuthorizationRules;
    workspaceId?: string | null;
    memberships?: Record<string, AuthorizationRole>;
}): Promise<AuthorizationRole> {
    return resolveRequestRole(deps(input.memberships), {
        principal: input.principal ?? sessionPrincipal(ACCOUNT_ID),
        activeAccountId: input.activeAccountId ?? null,
        rules: input.rules ?? rules(),
        workspaceId: input.workspaceId ?? null,
    });
}

describe('resolveRequestRole', () => {
    describe('anonymous (no accounts)', () => {
        it('returns default_role when default is viewer', async () => {
            await expect(
                resolve({
                    principal: ANONYMOUS,
                    rules: rules({ default_role: 'viewer' }),
                }),
            ).resolves.toBe('viewer');
        });

        it('returns default_role when default is restricted', async () => {
            await expect(resolve({ principal: ANONYMOUS })).resolves.toBe(
                'restricted',
            );
        });

        it('ignores authorized_accounts for anonymous', async () => {
            await expect(
                resolve({
                    principal: ANONYMOUS,
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'admin' },
                        },
                        default_role: 'viewer',
                    }),
                }),
            ).resolves.toBe('viewer');
        });
    });

    describe('per-account ladder', () => {
        it('falls through to default_role with no grant or membership', async () => {
            await expect(resolve({})).resolves.toBe('restricted');
        });

        it('explicit grant wins above default', async () => {
            await expect(
                resolve({
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'editor' },
                        },
                    }),
                }),
            ).resolves.toBe('editor');
        });

        it('explicit grant wins over workspace membership', async () => {
            await expect(
                resolve({
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'owner' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'viewer',
                    },
                }),
            ).resolves.toBe('owner');
        });

        it('explicit demotion wins over workspace membership', async () => {
            // Workspace admin explicitly demoted on a sensitive entity.
            await expect(
                resolve({
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'admin',
                    },
                }),
            ).resolves.toBe('viewer');
        });

        it.each(['owner', 'admin', 'editor', 'viewer'] as const)(
            'workspace membership passes through %s',
            async role => {
                // ADR 0011 §Step 4: memberships carry AuthorizationRole
                // directly — identity pass-through, no translation.
                await expect(
                    resolve({
                        workspaceId: WORKSPACE_ID,
                        memberships: {
                            [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: role,
                        },
                    }),
                ).resolves.toBe(role);
            },
        );

        it('skips the membership lookup when an explicit entry exists', async () => {
            let called = false;
            const spied: RoleResolutionDeps = {
                getMembershipRole: async () => {
                    called = true;
                    return 'admin';
                },
            };
            await expect(
                resolveRequestRole(spied, {
                    principal: sessionPrincipal(ACCOUNT_ID),
                    activeAccountId: null,
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                }),
            ).resolves.toBe('viewer');
            expect(called).toBe(false);
        });
    });

    describe('cross-account selection', () => {
        it('explicit-source account wins over workspace-source account', async () => {
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'checker' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${OTHER_ACCOUNT_ID}:${WORKSPACE_ID}`]: 'admin',
                    },
                }),
            ).resolves.toBe('checker');
        });

        it('workspace-source account wins over default-source account', async () => {
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${OTHER_ACCOUNT_ID}:${WORKSPACE_ID}`]: 'editor',
                    },
                }),
            ).resolves.toBe('editor');
        });

        it('all-default falls to default_role', async () => {
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    rules: rules({ default_role: 'viewer' }),
                }),
            ).resolves.toBe('viewer');
        });

        it('active-account header selects the acting account within a level', async () => {
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    activeAccountId: OTHER_ACCOUNT_ID,
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'admin' },
                            [OTHER_ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                }),
            ).resolves.toBe('viewer');
        });

        it('active-account header selects the acting account across specificity levels', async () => {
            // Account A explicitly demoted to viewer; account B is a
            // workspace admin with no explicit entry. The header names B:
            // B's grant is independently legitimate — the header is a
            // statement of who is acting, not a tiebreak hint, so B's
            // admin wins even though A's source is more specific.
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    activeAccountId: OTHER_ACCOUNT_ID,
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${OTHER_ACCOUNT_ID}:${WORKSPACE_ID}`]: 'admin',
                    },
                }),
            ).resolves.toBe('admin');
        });

        it('an explicitly demoted active account keeps its demotion', async () => {
            // The inverse: the header names the demoted account itself.
            // Selecting the acting account never escapes that account's
            // own explicit demotion.
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID, OTHER_ACCOUNT_ID),
                    activeAccountId: ACCOUNT_ID,
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'viewer' },
                        },
                    }),
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${OTHER_ACCOUNT_ID}:${WORKSPACE_ID}`]: 'admin',
                    },
                }),
            ).resolves.toBe('viewer');
        });

        it('ignores a header naming an account the principal does not hold', async () => {
            await expect(
                resolve({
                    principal: sessionPrincipal(ACCOUNT_ID),
                    activeAccountId: 'a/stranger',
                    rules: rules({
                        authorized_accounts: {
                            [ACCOUNT_ID]: { role: 'editor' },
                        },
                    }),
                }),
            ).resolves.toBe('editor');
        });
    });

    describe('credential principal', () => {
        it('resolves its single account through the same ladder', async () => {
            const principal: RequestPrincipal = {
                kind: 'credential',
                accounts: [account(ACCOUNT_ID)],
                credentialId: 'cred/1',
                boundEntityId: null,
            };
            await expect(
                resolve({
                    principal,
                    workspaceId: WORKSPACE_ID,
                    memberships: {
                        [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'editor',
                    },
                }),
            ).resolves.toBe('editor');
        });
    });
});

describe('resolvePreInitRole', () => {
    it('claimed owned account → owner', async () => {
        await expect(
            resolvePreInitRole(deps(), {
                principal: sessionPrincipal(ACCOUNT_ID),
                claimedAccountId: ACCOUNT_ID,
                claimedWorkspaceId: null,
            }),
        ).resolves.toBe('owner');
    });

    it('no claimed account → ownerless', async () => {
        await expect(
            resolvePreInitRole(deps(), {
                principal: ANONYMOUS,
                claimedAccountId: null,
                claimedWorkspaceId: null,
            }),
        ).resolves.toBe('ownerless');
    });

    it('claimed account the principal does not hold → throws', async () => {
        await expect(
            resolvePreInitRole(deps(), {
                principal: sessionPrincipal(ACCOUNT_ID),
                claimedAccountId: OTHER_ACCOUNT_ID,
                claimedWorkspaceId: null,
            }),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('claimed workspace without a claimed account → throws', async () => {
        await expect(
            resolvePreInitRole(deps(), {
                principal: ANONYMOUS,
                claimedAccountId: null,
                claimedWorkspaceId: WORKSPACE_ID,
            }),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('claimed workspace without membership → throws', async () => {
        await expect(
            resolvePreInitRole(deps(), {
                principal: sessionPrincipal(ACCOUNT_ID),
                claimedAccountId: ACCOUNT_ID,
                claimedWorkspaceId: WORKSPACE_ID,
            }),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('claimed workspace with membership → owner', async () => {
        await expect(
            resolvePreInitRole(
                deps({ [`${ACCOUNT_ID}:${WORKSPACE_ID}`]: 'editor' }),
                {
                    principal: sessionPrincipal(ACCOUNT_ID),
                    claimedAccountId: ACCOUNT_ID,
                    claimedWorkspaceId: WORKSPACE_ID,
                },
            ),
        ).resolves.toBe('owner');
    });
});

describe('canRead', () => {
    // ADR 0021 §Decision 1 view-floor (VIEW_ROLES). `ownerless` is
    // ABOVE the floor: anonymous-created Blanks (e.g. the Contributed
    // Lists) carry `default_role: 'ownerless'` and must stay publicly
    // readable. `system` reads too (it's a cluster-internal cascade
    // identity that mutates content). Only `restricted`/`submitter`
    // sit below the floor.
    it.each([
        'owner',
        'admin',
        'editor',
        'checker',
        'viewer',
        'ownerless',
        'system',
    ] as const)('%s can read', role => expect(canRead(role)).toBe(true));

    it.each(['restricted', 'submitter'] as const)('%s cannot read', role =>
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
