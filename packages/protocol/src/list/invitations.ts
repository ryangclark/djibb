import { z } from 'zod';

import { AccountRoleEnum, type AccountRole } from '../auth/rules';

/**
 * Pure invitation protocol (ADR 0009): the identity/status vocabulary,
 * the `pending_invites` row shape + its parser, and the lifetime/
 * normalization rules. Zero Cloudflare dependencies — the DO-resident
 * SQL helpers, D1 projection, and reconciler live backend-side and
 * import these contracts.
 */

export const InvitationIdentityKindEnum = z.enum(['email']);
export type InvitationIdentityKind = z.infer<typeof InvitationIdentityKindEnum>;

export const InvitationStatusEnum = z.enum([
    'pending',
    'accepted',
    'revoked',
    'expired',
]);
export type InvitationStatus = z.infer<typeof InvitationStatusEnum>;

/**
 * Default invitation lifetime — 7 days, per ADR 0009 §"Other policy
 * defaults." Lazy-expire on read (no cron); the index keeps the row
 * until cascade-delete or audit prune.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Normalize an identity value for storage and lookup. Email is
 * lower-cased; everything else passes through unchanged. The DO and D1
 * index both index by the normalized form so case-mismatched lookups
 * resolve cleanly.
 */
export function normalizeIdentityValue(
    kind: InvitationIdentityKind,
    value: string
): string {
    if (kind === 'email') return value.trim().toLowerCase();
    return value.trim();
}

export type PendingInviteRow = {
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    role: AccountRole;
    inviter_account_id: string;
    time_created: number; // unix seconds
    time_expires: number; // unix seconds
    time_deleted: number | null; // unix seconds; null ⇒ live
    version: number;
};

export const PendingInviteRowSchema = z.object({
    identity_kind: InvitationIdentityKindEnum,
    identity_value: z.string(),
    role: AccountRoleEnum,
    inviter_account_id: z.string(),
    time_created: z.number(),
    time_expires: z.number(),
    time_deleted: z.number().nullable(),
    version: z.number(),
});
