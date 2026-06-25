/**
 * Issued-credentials substrate (ADR 0022 §4) — the non-interactive
 * sibling to sessions.
 *
 * A *credential* is a pre-issued, single-Account **bearer token** a
 * client (the CLI, an email-reply integration, a standing bot) presents
 * to authenticate as an Account without a live sign-in ceremony. Where
 * the interactive methods (OAuth, magic-link) mint a multi-account
 * `session` (`auth/session.ts`), this module mints and verifies tokens
 * in their own `issued_credentials` substrate (migration 0015). Sessions
 * are untouched; the management surface unions both (ADR 0022 §6).
 *
 * This module owns two things:
 *   1. {@link CreateCredential} — mint a token (raw secret returned once;
 *      only its SHA-256 is persisted).
 *   2. {@link VerifyBearerCredential} — the verification half of the
 *      request→Account seam: take a presented bearer token, resolve its
 *      Account, reject revoked/expired/forged, and carry `bound_entity_id`
 *      forward for the per-entity authz check (NOT enforced here — the
 *      target entity isn't in scope at this seam; ADR 0022 §Negative).
 *
 * `resolveRole` (`auth/resolver.ts`) is deliberately untouched: a bearer
 * request resolves to an Account exactly as a cookie session does, then
 * flows through the single `(Account, entity) → role` model (ADR 0021).
 */
import { ParseError, UnexpectedError } from '@djibb/protocol/errors';
import { AccountSchema, type Account } from '@djibb/protocol/account';
import { newId, randomString } from '@djibb/protocol/id';

/**
 * Length of the random secret half of a bearer token. 43 url-safe chars
 * ≈ 258 bits of entropy — well past the threshold that makes unsalted
 * SHA-256 storage safe (no dictionary/rainbow surface; ADR 0022 §4).
 */
const SECRET_LENGTH = 43;

/**
 * Best-effort throttle for `time_last_used`: skip the write unless the
 * stored value is older than this. A write on every authenticated
 * request is a hot-path cost for a nicety (ADR 0022 §4).
 */
const LAST_USED_THROTTLE_SECONDS = 5 * 60;

/**
 * The acting credential, carried onto the request context after a bearer
 * token authenticates. `bound_entity_id` threads *forward* to the
 * per-entity authz check; this seam cannot enforce it (the entity is
 * route-dependent and not in scope here — ADR 0022 §Negative).
 */
export type ResolvedCredential = {
    account: Account;
    credential_id: string;
    bound_entity_id: string | null;
};

/**
 * SHA-256(raw) as lowercase hex. The raw secret lives only in the issued
 * token; a DB read alone cannot mint a live credential. Unsalted is
 * acceptable ONLY because secrets are high-entropy random (see
 * {@link SECRET_LENGTH}) — a low-entropy format would need a slow KDF.
 */
export async function hashSecret(raw: string): Promise<string> {
    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * A presented bearer token is `<credential_id>.<secret>`: the public
 * handle (safe to display) and the high-entropy secret, joined by the
 * one character neither half can contain (the url-safe id alphabet has
 * no `.`). Splitting on `.` therefore round-trips exactly.
 */
function parseBearerToken(
    token: string,
): { credentialId: string; secret: string } | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [credentialId, secret] = parts;
    if (!credentialId || !secret) return null;
    // Cheap shape gate before any DB/crypto work.
    if (!credentialId.startsWith('c/')) return null;
    if (secret.length !== SECRET_LENGTH) return null;

    return { credentialId, secret };
}

/**
 * Constant-time string compare. Both inputs are fixed-length hex digests
 * here, so this guards against timing oracles on the hash comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

/**
 * Mints a credential for `accountId` and returns the raw bearer token —
 * shown to the caller exactly once; only its SHA-256 is persisted. The
 * `credential_id` is a stable public handle for display/management.
 *
 * This is the substrate primitive; the client-facing mint UX (the CLI
 * device flow) layers on top of it in a later slice (GH #21).
 */
export async function CreateCredential(
    d1: D1Database,
    args: {
        accountId: string;
        label?: string | null;
        boundEntityId?: string | null;
        /** Absolute unix-seconds expiry. Omit for a non-expiring (revoke-only) token. */
        timeExpires?: number | null;
        /** Override "now" (unix seconds) for deterministic tests. */
        now?: number;
    },
): Promise<{ credentialId: string; token: string }> {
    const credentialId = newId('credential');
    const secret = randomString(SECRET_LENGTH);
    const secretHash = await hashSecret(secret);
    const now = args.now ?? Math.floor(Date.now() / 1000);

    try {
        await d1
            .prepare(
                `INSERT INTO issued_credentials (
                    credential_id,
                    secret_hash,
                    account_id,
                    label,
                    bound_entity_id,
                    time_created,
                    time_expires
                ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
            )
            .bind(
                credentialId,
                secretHash,
                args.accountId,
                args.label ?? null,
                args.boundEntityId ?? null,
                now,
                args.timeExpires ?? null,
            )
            .run();
    } catch (error: any) {
        console.error(
            '`CreateCredential()` insert error:',
            error?.message || error,
        );
        throw new UnexpectedError();
    }

    return { credentialId, token: `${credentialId}.${secret}` };
}

/**
 * Verifies a presented bearer token and resolves the Account it acts as.
 * Returns `null` (never throws) for every "not authenticated" case so the
 * seam can fall through to anonymous: malformed token, unknown handle,
 * forged secret, revoked, or expired.
 *
 * `bound_entity_id` is returned for forward-threading but NOT enforced —
 * the target entity is not in scope at this seam (ADR 0022 §Negative).
 *
 * `time_last_used` is updated best-effort/throttled and only when a
 * `waitUntil` is provided (the Workers mechanism for off-the-hot-path
 * work). Callers without one — and the throttle window — simply skip it.
 */
export async function VerifyBearerCredential(
    d1: D1Database,
    bearerToken: string,
    options?: {
        waitUntil?: (promise: Promise<unknown>) => void;
        /** Override "now" (unix seconds) for deterministic tests. */
        now?: number;
    },
): Promise<ResolvedCredential | null> {
    const parsed = parseBearerToken(bearerToken);
    if (!parsed) return null;

    const presentedHash = await hashSecret(parsed.secret);
    const now = options?.now ?? Math.floor(Date.now() / 1000);

    let row: Record<string, any> | null;
    try {
        row = await d1
            .prepare(
                `SELECT
                    ic.secret_hash AS secret_hash,
                    ic.bound_entity_id AS bound_entity_id,
                    ic.time_expires AS time_expires,
                    ic.time_revoked AS time_revoked,
                    ic.time_last_used AS time_last_used,
                    accounts.id AS account_id,
                    accounts.display_name AS display_name,
                    accounts.email AS email,
                    accounts.email_verified AS email_verified,
                    accounts.flags AS flags,
                    accounts.image AS image,
                    accounts.provider_name AS provider_name,
                    accounts.provider_client_id AS provider_client_id,
                    accounts.time_created AS account_time_created,
                    accounts.time_deleted AS account_time_deleted,
                    accounts.time_updated AS account_time_updated,
                    accounts.user_name AS user_name
                FROM issued_credentials ic
                JOIN accounts ON accounts.id = ic.account_id
                WHERE ic.credential_id = ?;`,
            )
            .bind(parsed.credentialId)
            .first();
    } catch (error: any) {
        console.error(
            '`VerifyBearerCredential()` query error:',
            error?.message || error,
        );
        throw new UnexpectedError();
    }

    if (!row) return null;

    // Forged or stale secret — constant-time compare against the stored
    // hash. A wrong secret for a real handle must be indistinguishable
    // from an unknown handle.
    if (!timingSafeEqual(presentedHash, row.secret_hash)) return null;

    // Soft state: revoked is terminal; expired is past its window.
    if (row.time_revoked != null) return null;
    if (row.time_expires != null && row.time_expires <= now) return null;

    const account = parseAccountRow(row);

    // Best-effort, throttled, off the hot path.
    if (
        options?.waitUntil &&
        (row.time_last_used == null ||
            now - row.time_last_used > LAST_USED_THROTTLE_SECONDS)
    ) {
        options.waitUntil(
            touchLastUsed(d1, parsed.credentialId, now).catch(error => {
                // Best-effort: a failed touch must never fail the request.
                console.error('`touchLastUsed()` error:', error);
            }),
        );
    }

    return {
        account,
        credential_id: parsed.credentialId,
        bound_entity_id: row.bound_entity_id ?? null,
    };
}

/**
 * Binding enforcement (ADR 0022 §Negative consequences, GH #20). A
 * credential bound to an entity (`bound_entity_id` set) may act ONLY on
 * that entity; on any other it is denied. Unbound credentials (`NULL`) and
 * absent ones (cookie sessions / anonymous) are unaffected — usable
 * wherever the Account has access.
 *
 * Prefix-agnostic equality, so one check covers a bound List, Template,
 * Workspace, or Account: the id prefix (`l/`, `t/`, `w/`, `a/`) is part of
 * the compared value (ADR 0022 §4).
 *
 * Pure predicate by design: the binding *cannot* be enforced at the
 * request→Account seam (the target entity isn't in scope there), so the
 * carrier threads forward and this rule is applied at the per-entity authz
 * check, where the entity is finally known. Returns `true` to permit,
 * `false` to deny.
 */
export function credentialPermitsEntity(
    credential: ResolvedCredential | null,
    entityId: string,
): boolean {
    if (!credential || credential.bound_entity_id == null) return true;
    return credential.bound_entity_id === entityId;
}

/**
 * Revoke a credential **only if it is bound to `entityId`** (GH #24). This
 * is the structural guarantee behind the connected-clients manager-revoke
 * rule: a workspace manager may sever a client's access to *this entity*,
 * never to an Account. An entity-bound token's entire power is this one
 * entity, so revoking it is entity-scoped by construction; the
 * `bound_entity_id = ?` predicate in the UPDATE makes it impossible for this
 * path to touch an account-wide session or unbound token, or a token bound
 * elsewhere — those simply don't match and `rowsWritten` is 0.
 *
 * Idempotent: a second revoke (already `time_revoked`) matches nothing and
 * returns false. Returns true iff a live, this-entity-bound credential was
 * revoked.
 */
export async function RevokeEntityBoundCredential(
    d1: D1Database,
    args: { credentialId: string; entityId: string; now?: number },
): Promise<boolean> {
    const now = args.now ?? Math.floor(Date.now() / 1000);
    try {
        const cursor = await d1
            .prepare(
                `UPDATE issued_credentials
                 SET time_revoked = ?
                 WHERE credential_id = ?
                   AND bound_entity_id = ?
                   AND time_revoked IS NULL;`,
            )
            .bind(now, args.credentialId, args.entityId)
            .run();
        return (cursor.meta.changes ?? 0) > 0;
    } catch (error: any) {
        console.error(
            '`RevokeEntityBoundCredential()` update error:',
            error?.message || error,
        );
        throw new UnexpectedError();
    }
}

/** Records `time_last_used` for an authenticated credential. */
function touchLastUsed(d1: D1Database, credentialId: string, now: number) {
    return d1
        .prepare(
            'UPDATE issued_credentials SET time_last_used = ? WHERE credential_id = ?',
        )
        .bind(now, credentialId)
        .run();
}

/**
 * Builds an {@link Account} from a credentials⋈accounts join row,
 * mirroring `GetSessionById` in `auth/session.ts`.
 */
function parseAccountRow(row: Record<string, any>): Account {
    const candidate = {
        id: row.account_id,
        display_name: row.display_name,
        email: row.email,
        email_verified: row.email_verified,
        flags: row.flags ? JSON.parse(row.flags) : null,
        image: row.image,
        provider_name: row.provider_name,
        provider_client_id: row.provider_client_id,
        time_created: new Date(row.account_time_created * 1000),
        time_deleted: row.account_time_deleted
            ? new Date(row.account_time_deleted * 1000)
            : null,
        time_updated: new Date(row.account_time_updated * 1000),
        user_name: row.user_name,
    };

    const parseResult = AccountSchema.safeParse(candidate);
    if (!parseResult.success) {
        console.error(
            '`VerifyBearerCredential()` account parse error:',
            ...parseResult.error.issues.map(issue => ({
                ...issue,
                path: issue.path.join('/'),
            })),
        );
        throw new ParseError();
    }

    return parseResult.data;
}
