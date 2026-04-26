import { Bindings } from '..';

export interface InvitationEmailParams {
    to: string;
    workspaceName: string;
    inviterName: string;
    acceptUrl: string;
}

export async function sendInvitationEmail(
    env: Bindings,
    params: InvitationEmailParams
): Promise<void> {
    const from = env.EMAIL_FROM || 'no-reply@djibb.app';
    const subject = `${sanitizeHeader(params.inviterName)} invited you to ${sanitizeHeader(params.workspaceName)} on djibb`;

    const text =
        `${params.inviterName} invited you to join "${params.workspaceName}" on djibb.\n\n` +
        `Accept the invite:\n${params.acceptUrl}\n\n` +
        `If you weren't expecting this, you can ignore this email.\n`;

    const html =
        `<p><strong>${escapeHtml(params.inviterName)}</strong> invited you to join ` +
        `<strong>${escapeHtml(params.workspaceName)}</strong> on djibb.</p>` +
        `<p><a href="${escapeAttr(params.acceptUrl)}">Accept the invite</a></p>` +
        `<p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`;

    await env.EMAIL.send({
        from: {email: from, name: 'djibb invites'},
        to: params.to,
        subject,
        html,
        text,
    });
}

function sanitizeHeader(s: string): string {
    return s.replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/"/g, '&quot;');
}
