import type { Bindings } from '..';
import { runEmailSend, type OutboundEmail } from '../effect/email';

// ADR 0011 §7b.3: `sendInvitationEmail` (the workspace token flow) is
// gone with the rest of the legacy invitation system. `sendEntityInvitationEmail`
// below is the only invitation email path now.

// Message *construction* is pure (`build*Email` below, exported so the
// copy/escaping is assertable in plain vitest); the *send* runs through
// the EmailSender Effect service (`effect/email.ts`) with a bounded
// transient retry and a typed `EmailSendError` rejection. The exported
// send functions keep their `(env, params) => Promise<void>` shape —
// Effect never escapes to callers (ADR 0015).

/**
 * Resolve the `from` address for outbound mail. Single source of truth
 * for every send function so the sender isn't hardcoded in each. Driven
 * by `EMAIL_FROM` (a `wrangler.toml` var); the last-resort literal is
 * only reached if that var is somehow unset, and it stays on the domain
 * we actually control (djibb.com) — never the old, unowned djibb.app.
 */
export function resolveEmailFrom(env: Pick<Bindings, 'EMAIL_FROM'>): string {
    return env.EMAIL_FROM?.trim() || 'no-reply@djibb.com';
}

export interface EntityInvitationEmailParams {
    to: string;
    /** "list", "template", or "workspace" — drives subject phrasing. */
    entityTypeLabel: 'list' | 'template' | 'workspace';
    /** Display name of the entity. May be empty; falls back to a
     *  generic phrase. */
    entityName: string;
    /** Display name of the inviter. May be empty; falls back to
     *  "Someone." */
    inviterName: string;
    /** Direct URL to the entity — accept fires from there. v1 points to
     *  `/{l|t}/<id>?from_invite=1`. */
    acceptUrl: string;
}

/**
 * Message body for ADR 0009 entity invites (List / Template).
 * Tokenless — the URL is just the entity page, which the invitee
 * loads, signs in if needed, and accepts from.
 */
export function buildEntityInvitationEmail(
    from: string,
    params: EntityInvitationEmailParams,
): OutboundEmail {
    const inviter = params.inviterName?.trim() || 'Someone';
    const entityName =
        params.entityName?.trim() || `a ${params.entityTypeLabel}`;
    const subject = `${sanitizeHeader(inviter)} shared ${sanitizeHeader(entityName)} with you on djibb`;

    const text =
        `${inviter} invited you to "${entityName}" on djibb.\n\n` +
        `Open the ${params.entityTypeLabel}:\n${params.acceptUrl}\n\n` +
        `If you weren't expecting this, you can ignore this email.\n`;

    const html =
        `<p><strong>${escapeHtml(inviter)}</strong> invited you to ` +
        `<strong>${escapeHtml(entityName)}</strong> on djibb.</p>` +
        `<p><a href="${escapeAttr(params.acceptUrl)}">Open the ${escapeHtml(params.entityTypeLabel)}</a></p>` +
        `<p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`;

    return {
        from: { email: from, name: 'djibb invites' },
        to: params.to,
        subject,
        html,
        text,
    };
}

/**
 * Invitation email for ADR 0009 entity invites (List / Template).
 * Sibling of the ownership-transfer senders below; kept separate so the
 * upcoming Accounts-as-DjibbList refactor can evolve the entity path
 * without touching the workspace branch.
 */
export async function sendEntityInvitationEmail(
    env: Bindings,
    params: EntityInvitationEmailParams
): Promise<void> {
    await runEmailSend(
        env.EMAIL,
        buildEntityInvitationEmail(resolveEmailFrom(env), params),
    );
}

export interface OwnershipTransferEmailParams {
    /** New owner's email — the recipient of this confirmation. */
    to: string;
    /** "list", "template", or "workspace" — drives subject phrasing. */
    entityTypeLabel: 'list' | 'template' | 'workspace';
    /** Display name of the entity. May be empty; falls back to a
     *  generic phrase. */
    entityName: string;
    /** Display name of the former owner who initiated the transfer.
     *  May be empty; falls back to "Someone." */
    formerOwnerName: string;
    /** Direct URL to the entity. Unlike the invite path there's no
     *  `?from_invite=1` — the transfer already granted `owner` access,
     *  so this is a notification, not an accept gate. */
    entityUrl: string;
}

export function buildOwnershipTransferEmail(
    from: string,
    params: OwnershipTransferEmailParams,
): OutboundEmail {
    const formerOwner = params.formerOwnerName?.trim() || 'Someone';
    const entityName =
        params.entityName?.trim() || `a ${params.entityTypeLabel}`;
    const subject = `You're now the owner of ${sanitizeHeader(entityName)} on djibb`;

    const text =
        `${formerOwner} transferred ownership of "${entityName}" to you on djibb.\n\n` +
        `You now have full control of this ${params.entityTypeLabel}.\n\n` +
        `Open it:\n${params.entityUrl}\n\n` +
        `If you weren't expecting this, reach out to ${formerOwner}.\n`;

    const html =
        `<p><strong>${escapeHtml(formerOwner)}</strong> transferred ownership of ` +
        `<strong>${escapeHtml(entityName)}</strong> to you on djibb.</p>` +
        `<p>You now have full control of this ${escapeHtml(params.entityTypeLabel)}.</p>` +
        `<p><a href="${escapeAttr(params.entityUrl)}">Open the ${escapeHtml(params.entityTypeLabel)}</a></p>` +
        `<p style="color:#888;font-size:12px">If you weren't expecting this, reach out to ${escapeHtml(formerOwner)}.</p>`;

    return {
        from: { email: from, name: 'djibb' },
        to: params.to,
        subject,
        html,
        text,
    };
}

/**
 * Confirmation email for an ownership transfer (ADR 0011 §Decision C,
 * Phase 5 polish). Sent to the *new* owner once `transferOwnership`
 * commits: ownership is transferred immediately and is not an
 * accept-gated invite (the former owner is demoted to `admin` in the
 * same mutation), so this is a heads-up receipt rather than a call to
 * action. Sibling of `sendEntityInvitationEmail`; kept separate so the
 * copy and (future) former-owner receipt can evolve independently.
 */
export async function sendOwnershipTransferEmail(
    env: Bindings,
    params: OwnershipTransferEmailParams
): Promise<void> {
    await runEmailSend(
        env.EMAIL,
        buildOwnershipTransferEmail(resolveEmailFrom(env), params),
    );
}

export interface OwnershipTransferReceiptEmailParams {
    /** Former owner's email — the recipient of this receipt. */
    to: string;
    /** "list", "template", or "workspace" — drives subject phrasing. */
    entityTypeLabel: 'list' | 'template' | 'workspace';
    /** Display name of the entity. May be empty; falls back to a
     *  generic phrase. */
    entityName: string;
    /** Display name (or email) of the account that received ownership.
     *  May be empty; falls back to "another member." */
    newOwnerName: string;
    /** Direct URL to the entity. */
    entityUrl: string;
}

export function buildOwnershipTransferReceiptEmail(
    from: string,
    params: OwnershipTransferReceiptEmailParams,
): OutboundEmail {
    const newOwner = params.newOwnerName?.trim() || 'another member';
    const entityName =
        params.entityName?.trim() || `your ${params.entityTypeLabel}`;
    const subject = `You transferred ownership of ${sanitizeHeader(entityName)} on djibb`;

    const text =
        `You transferred ownership of "${entityName}" to ${newOwner} on djibb.\n\n` +
        `You're now an admin of this ${params.entityTypeLabel}.\n\n` +
        `Open it:\n${params.entityUrl}\n\n` +
        `If you didn't make this change, your account may be compromised — ` +
        `secure it and contact support.\n`;

    const html =
        `<p>You transferred ownership of ` +
        `<strong>${escapeHtml(entityName)}</strong> to ` +
        `<strong>${escapeHtml(newOwner)}</strong> on djibb.</p>` +
        `<p>You're now an admin of this ${escapeHtml(params.entityTypeLabel)}.</p>` +
        `<p><a href="${escapeAttr(params.entityUrl)}">Open the ${escapeHtml(params.entityTypeLabel)}</a></p>` +
        `<p style="color:#888;font-size:12px">If you didn't make this change, your account may be compromised — secure it and contact support.</p>`;

    return {
        from: { email: from, name: 'djibb' },
        to: params.to,
        subject,
        html,
        text,
    };
}

/**
 * Receipt email for the *former* owner after a transfer (ADR 0011
 * §Decision C, Phase 5). Sibling of `sendOwnershipTransferEmail` (which
 * notifies the new owner). Its primary value is accountability /
 * compromise detection — the same rationale as a "new sign-in" email:
 * if the former owner didn't make this change, the receipt is how they
 * find out. The recipient-must-be-a-member guard already prevents
 * transfer to a stranger, so this is hygiene, not the abuse boundary.
 */
export async function sendOwnershipTransferReceiptEmail(
    env: Bindings,
    params: OwnershipTransferReceiptEmailParams
): Promise<void> {
    await runEmailSend(
        env.EMAIL,
        buildOwnershipTransferReceiptEmail(resolveEmailFrom(env), params),
    );
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
export function buildMagicLinkEmail(
    from: string,
    params: MagicLinkEmailParams,
): OutboundEmail {
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

    return {
        from: { email: from, name: 'djibb sign-in' },
        to: params.to,
        subject,
        html,
        text,
    };
}

export async function sendMagicLinkEmail(
    env: Bindings,
    params: MagicLinkEmailParams
): Promise<void> {
    await runEmailSend(
        env.EMAIL,
        buildMagicLinkEmail(resolveEmailFrom(env), params),
    );
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
