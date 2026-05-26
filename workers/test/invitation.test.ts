import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';

import { CreateAccount } from '../src/account/service';
import { SetAccountUsername } from '../src/account/username';
import {
    AcceptInvitation,
    CreateInvitation,
    GetInvitationPreview,
    ListInvitations,
    RevokeInvitation,
} from '../src/workspace/invitations';
import {
    ChangeMemberRole,
    CreateWorkspace,
    GetMembership,
    GetWorkspaceMembers,
    RemoveMember,
} from '../src/workspace/service';
import type { Account } from '../src/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
        display_name: 'Test User',
        email: `t-${Math.random().toString(36).slice(2)}@example.com`,
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g-' + Math.random().toString(36).slice(2),
        user_name: null,
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

async function setup() {
    const owner = await CreateAccount(env, makeAccount());
    const ws = await CreateWorkspace(env.DJIBB_AUTH, owner.id, {
        slug: 'team-alpha',
        name: 'Team Alpha',
    });
    return { owner, ws };
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('CreateInvitation authorization', () => {
    it('rejects non-admins', async () => {
        const { owner, ws } = await setup();
        const stranger = await CreateAccount(env, makeAccount());
        await expect(
            CreateInvitation(env.DJIBB_AUTH, stranger.id, ws.slug, {
                type: 'email',
                email: 'x@example.com',
                role: 'viewer',
            })
        ).rejects.toThrow(/member|owner|admin/i);
    });

    it('rejects invites on personal workspaces', async () => {
        const owner = await CreateAccount(env, makeAccount());
        const memberships = await env.DJIBB_AUTH
            .prepare(
                `SELECT w.slug FROM workspaces w
                 JOIN AccountWorkspace aw ON aw.workspace_id = w.id
                 WHERE aw.account_id = ? AND w.is_personal = 1 LIMIT 1`
            )
            .bind(owner.id)
            .first<{ slug: string }>();
        const personalSlug = memberships!.slug;
        await expect(
            CreateInvitation(env.DJIBB_AUTH, owner.id, personalSlug, {
                type: 'email',
                email: 'x@example.com',
                role: 'viewer',
            })
        ).rejects.toThrow(/personal/i);
    });

    it('rejects email type when inviter email is not verified', async () => {
        const owner = await CreateAccount(env,
            makeAccount({ email_verified: false })
        );
        const ws = await CreateWorkspace(env.DJIBB_AUTH, owner.id, {
            slug: 'unverified-team',
            name: 'X',
        });
        await expect(
            CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
                type: 'email',
                email: 'x@example.com',
                role: 'viewer',
            })
        ).rejects.toThrow(/verified/i);
    });
});

describe('CreateInvitation per-type behavior', () => {
    it('email invite stores lowercased target_email', async () => {
        const { owner, ws } = await setup();
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'email',
            email: 'Eva@Example.COM',
            role: 'viewer',
        });
        expect(inv.target_email).toBe('eva@example.com');
        expect(inv.token.length).toBeGreaterThan(10);
        expect(inv.status).toBe('pending');
    });

    it('username invite resolves to target_account_id', async () => {
        const { owner, ws } = await setup();
        const target = await CreateAccount(env, makeAccount());
        await SetAccountUsername(env.DJIBB_AUTH, target.id, 'frank');
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'username',
            username: 'frank',
            role: 'viewer',
        });
        expect(inv.target_account_id).toBe(target.id);
    });

    it('username invite rejects unknown username', async () => {
        const { owner, ws } = await setup();
        await expect(
            CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
                type: 'username',
                username: 'nobody-here',
                role: 'viewer',
            })
        ).rejects.toThrow(/no account/i);
    });

    it('link invite caps max_uses at 500', async () => {
        const { owner, ws } = await setup();
        await expect(
            CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
                type: 'link',
                max_uses: 9999,
                role: 'viewer',
            })
        ).rejects.toThrow();
    });
});

describe('AcceptInvitation', () => {
    it('email type: matching account joins, status becomes accepted', async () => {
        const { owner, ws } = await setup();
        const inviteeEmail = 'newbie@example.com';
        const invitee = await CreateAccount(env,
            makeAccount({ email: inviteeEmail, email_verified: true })
        );
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'email',
            email: inviteeEmail,
            role: 'viewer',
        });
        const result = await AcceptInvitation(
            env.DJIBB_AUTH,
            invitee.id,
            inv.token
        );
        expect(result.workspace_slug).toBe(ws.slug);
        expect(result.membership_created).toBe(true);
        const m = await GetMembership(env.DJIBB_AUTH, invitee.id, ws.id);
        expect(m?.role).toBe('viewer');
    });

    it('email type: rejects mismatched email', async () => {
        const { owner, ws } = await setup();
        const wrong = await CreateAccount(env,
            makeAccount({ email: 'wrong@example.com' })
        );
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'email',
            email: 'right@example.com',
            role: 'viewer',
        });
        await expect(
            AcceptInvitation(env.DJIBB_AUTH, wrong.id, inv.token)
        ).rejects.toThrow(/different/i);
    });

    it('username type: only target account can accept', async () => {
        const { owner, ws } = await setup();
        const target = await CreateAccount(env, makeAccount());
        const intruder = await CreateAccount(env, makeAccount());
        await SetAccountUsername(env.DJIBB_AUTH, target.id, 'gabe');
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'username',
            username: 'gabe',
            role: 'viewer',
        });
        await expect(
            AcceptInvitation(env.DJIBB_AUTH, intruder.id, inv.token)
        ).rejects.toThrow();
        await AcceptInvitation(env.DJIBB_AUTH, target.id, inv.token);
        const m = await GetMembership(env.DJIBB_AUTH, target.id, ws.id);
        expect(m?.role).toBe('viewer');
    });

    it('link type: multi-use until max_uses reached', async () => {
        const { owner, ws } = await setup();
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            max_uses: 2,
            role: 'viewer',
        });
        const j1 = await CreateAccount(env, makeAccount());
        const j2 = await CreateAccount(env, makeAccount());
        const j3 = await CreateAccount(env, makeAccount());
        await AcceptInvitation(env.DJIBB_AUTH, j1.id, inv.token);
        await AcceptInvitation(env.DJIBB_AUTH, j2.id, inv.token);
        await expect(
            AcceptInvitation(env.DJIBB_AUTH, j3.id, inv.token)
        ).rejects.toThrow(/already been used|max/i);
    });

    it('idempotent re-accept by an existing member is a no-op', async () => {
        const { owner, ws } = await setup();
        const invitee = await CreateAccount(env,
            makeAccount({ email: 'iden@example.com', email_verified: true })
        );
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            max_uses: 5,
            role: 'viewer',
        });
        await AcceptInvitation(env.DJIBB_AUTH, invitee.id, inv.token);
        const second = await AcceptInvitation(
            env.DJIBB_AUTH,
            invitee.id,
            inv.token
        );
        expect(second.membership_created).toBe(false);
    });

    it('rejects revoked invitations', async () => {
        const { owner, ws } = await setup();
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'viewer',
        });
        await RevokeInvitation(env.DJIBB_AUTH, owner.id, ws.slug, inv.id);
        const j = await CreateAccount(env, makeAccount());
        await expect(
            AcceptInvitation(env.DJIBB_AUTH, j.id, inv.token)
        ).rejects.toThrow(/revoked/i);
    });
});

describe('ListInvitations + Revoke', () => {
    it('admin sees pending invitations and can revoke', async () => {
        const { owner, ws } = await setup();
        await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'viewer',
        });
        const inv2 = await CreateInvitation(
            env.DJIBB_AUTH,
            owner.id,
            ws.slug,
            { type: 'link', role: 'viewer' }
        );

        let pending = await ListInvitations(env.DJIBB_AUTH, owner.id, ws.slug);
        expect(pending).toHaveLength(2);

        await RevokeInvitation(env.DJIBB_AUTH, owner.id, ws.slug, inv2.id);
        pending = await ListInvitations(env.DJIBB_AUTH, owner.id, ws.slug);
        expect(pending).toHaveLength(1);
    });

    it('preview is publicly fetchable by token', async () => {
        const { owner, ws } = await setup();
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'viewer',
        });
        const preview = await GetInvitationPreview(env.DJIBB_AUTH, inv.token);
        expect(preview.workspace.slug).toBe(ws.slug);
        expect(preview.role).toBe('viewer');
    });
});

describe('Member role + remove', () => {
    it('owner can promote and demote members', async () => {
        const { owner, ws } = await setup();
        const m = await CreateAccount(env, makeAccount());
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'viewer',
        });
        await AcceptInvitation(env.DJIBB_AUTH, m.id, inv.token);

        await ChangeMemberRole(env.DJIBB_AUTH, owner.id, ws.slug, m.id, 'admin');
        const after = await GetMembership(env.DJIBB_AUTH, m.id, ws.id);
        expect(after?.role).toBe('admin');
    });

    it('blocks demoting the last owner', async () => {
        const { owner, ws } = await setup();
        await expect(
            ChangeMemberRole(
                env.DJIBB_AUTH,
                owner.id,
                ws.slug,
                owner.id,
                'admin'
            )
        ).rejects.toThrow(/last owner/i);
    });

    it('admin cannot remove an owner', async () => {
        const { owner, ws } = await setup();
        const adminAcct = await CreateAccount(env, makeAccount());
        const inv = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'admin',
        });
        await AcceptInvitation(env.DJIBB_AUTH, adminAcct.id, inv.token);
        await expect(
            RemoveMember(env.DJIBB_AUTH, adminAcct.id, ws.slug, owner.id)
        ).rejects.toThrow(/owner/i);
    });

    it('admin can remove a non-owner', async () => {
        const { owner, ws } = await setup();
        const adminAcct = await CreateAccount(env, makeAccount());
        const member = await CreateAccount(env, makeAccount());
        const inv1 = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'admin',
        });
        const inv2 = await CreateInvitation(env.DJIBB_AUTH, owner.id, ws.slug, {
            type: 'link',
            role: 'viewer',
        });
        await AcceptInvitation(env.DJIBB_AUTH, adminAcct.id, inv1.token);
        await AcceptInvitation(env.DJIBB_AUTH, member.id, inv2.token);
        await RemoveMember(env.DJIBB_AUTH, adminAcct.id, ws.slug, member.id);

        const members = await GetWorkspaceMembers(env.DJIBB_AUTH, ws.id);
        expect(members.find(m => m.account_id === member.id)).toBeUndefined();
    });
});
