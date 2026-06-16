import { z } from 'zod';
import { type AuthorizationRole } from '@djibb/protocol/auth/rules';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0009 Slice 3 — accept a pending invitation. The invitee's session
 * carries an authenticated account; this mutator promotes that account
 * to the role recorded on the matching `pending_invites` row and
 * tombstones the row in the same DO commit. The post-commit emit path
 * marks the corresponding D1 index row `status='accepted'` (separate
 * code path from the reconciler so the row isn't downgraded to revoked
 * by the "missing in DO" diff).
 *
 * Special role surface. The mutator's `requiredRole` covers *every*
 * AuthorizationRole — including `restricted`. The role gate is the
 * thing being modified here: a brand-new invitee resolves to
 * `restricted` until this mutator commits, so demanding any higher role
 * would make acceptance unreachable. The HTTP `/push` boundary
 * separately exempts accept-only pushes from its own `restricted`
 * block (see `fetch.ts`), and enforces identity ownership via
 * `preflightAcceptInvitation` so a `restricted` caller can't ride this
 * exemption to run anything else.
 *
 * Constructive — no pre-state needed; the identity + listId are in the
 * forward args. Intentionally NOT undoable: an "undo accept" would
 * either silently strip the user's access (surprising) or recreate a
 * pending invite they could re-accept (no-op). The runtime treats a
 * `null` inverse as a silent skip — acceptance just doesn't enter the
 * undo history.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    identity_kind: z.ZodEnum<{
        email: "email";
    }>;
    identity_value: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "acceptInvitation";
/**
 * Every role — including `restricted` — can run this. See the file-
 * level comment for why the gate is intentionally open here. The HTTP
 * boundary's identity-match preflight is the real security gate; the
 * server mutator additionally re-checks the DO pending_invites row to
 * guard against a race where the invitation was revoked between
 * preflight and commit.
 */
export declare const requiredRole: readonly AuthorizationRole[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Intentionally not undoable. See file-level comment.
 */
export declare const inverse: Inverse<Args>;
