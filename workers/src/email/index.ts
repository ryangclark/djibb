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

export interface MagicLinkEmailParams {
    to: string;
    landingUrl: string;
    ttlMinutes: number;
}

/**
 * Sign-in email containing a one-time magic link (ADR 0010).
 *
 * The `landingUrl` points to the worker's interstitial page, not
 * directly to /consume — this defeats mail-scanner GET prefetch
 * (the interstitial requires a user click to POST).
 *
 * No personalization: we don't know the recipient's Account state at
 * send time. The body is intentionally generic ("Sign in to djibb")
 * rather than "Welcome back, $name" — the request handler returns
 * 200 unconditionally to avoid disclosing whether an Account exists,
 * and the email body must not undo that.
 */
export async function sendMagicLinkEmail(
    env: Bindings,
    params: MagicLinkEmailParams
): Promise<void> {
    const from = env.EMAIL_FROM || 'no-reply@djibb.app';
    const subject = 'Sign in to djibb';

    const text =
        `Sign in to djibb by opening this link:\n\n` +
        `${params.landingUrl}\n\n` +
        `This link expires in ${params.ttlMinutes} minutes and can be used once.\n\n` +
        `If you didn't request this, you can safely ignore this email.\n`;

    const html =
        `<p>Sign in to djibb by clicking the link below:</p>` +
        `<p><a href="${escapeAttr(params.landingUrl)}">Sign in to djibb</a></p>` +
        `<p style="color:#666;font-size:13px">This link expires in ${params.ttlMinutes} minutes and can be used once.</p>` +
        `<p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>`;

    await env.EMAIL.send({
        from: {email: from, name: 'djibb sign-in'},
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
