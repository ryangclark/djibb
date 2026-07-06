/**
 * Auth-substrate owner module (ADR 0025): the only file that issues D1
 * SQL against `sessions`, `AccountSession`, `accounts` (reads),
 * `issued_credentials`, and `magic_link_tokens`. D1 is authoritative
 * for these tables (unlike the Derived Index, which is a projection).
 * Callers use the named operations; SQL and multi-statement atomicity
 * stay inside.
 */

import { z } from 'zod';
import { createDate, isWithinExpirationDate } from 'oslo';
import { SESSION_EXPIRATION } from './constants';
import { ParseError, UnexpectedError } from '@djibb/protocol/errors';
import { DatelikeToDateSchema } from '@djibb/protocol/schema';
import { AccountSchema, type Account } from '@djibb/protocol/account';
import { newId, randomString } from '@djibb/protocol/id';
import { accountFromRow } from './account-row';

// ═══ from auth/session.ts ═══

/**
 * Attributes that are optional to a session.
 *
 * NOTE: you *can* overwrite fields here – use caution!
 */
export const SessionAttributesSchema = z.object({
    accounts: z.array(AccountSchema).readonly(),
    ip_country: z.string().optional(),
});

export type SessionAttributes = z.TypeOf<typeof SessionAttributesSchema>;

export const SessionSchema = SessionAttributesSchema.extend({
    fresh: z.boolean(),
    id: z.string(),
    time_created: DatelikeToDateSchema,
    time_expires: DatelikeToDateSchema,
});

export type Session = z.TypeOf<typeof SessionSchema>;

export type DatabaseSession = {
    id: string;
    time_created: number;
    time_expires: number;
} & SessionAttributes;

/**
 * Creates a new user session.
 *
 * If you provide a Session ID, we merge the given `attributes` with
 * those of the existing session, then delete that session.
 */
export async function CreateSession(
    d1: D1Database,
    attributes: SessionAttributes,
    fromSessionId?: string
) {
    const session: Session = {
        fresh: true,
        id: newId('session'),
        time_created: new Date(),
        time_expires: createDate(SESSION_EXPIRATION),
        ...attributes,
    };

    const preparedStatements: Array<D1PreparedStatement> = [];

    if (fromSessionId) {
        // Pull existing session to copy its info to new session.
        try {
            const databaseSession = await GetSessionById(d1, fromSessionId);

            if (databaseSession) {
                // Add each account to an object to handle any duplicates.
                const accounts: Record<string, Account> = {};

                for (const account of databaseSession.accounts) {
                    accounts[account.id] = account;
                }
                for (const account of attributes.accounts) {
                    accounts[account.id] = account;
                }

                session.accounts = Object.values(accounts);
            }
        } catch (error) {
            throw new UnexpectedError();
        }

        // First, delete the AccountSession relationships.
        preparedStatements.push(prep_DeleteAccountSession(d1, fromSessionId));

        // Next, delete the Session itself.
        preparedStatements.push(prep_DeleteSession(d1, fromSessionId));
    }

    if (!attributes.accounts.length) {
        throw new Error('`CreateSession()` error: invalid `accounts`!');
    }

    const sessionInsert = d1
        .prepare(
            `INSERT INTO sessions (
                id,
                ip_country,
                time_created,
                time_expires
            ) VALUES (?, ?, ?, ?)`
        )
        .bind(
            session.id,
            attributes.ip_country,
            Math.floor(session.time_created.getTime() / 1000),
            Math.floor(session.time_expires.getTime() / 1000)
        );

    preparedStatements.push(sessionInsert);

    // Create the query to insert relationships between the session
    // and its authorized accounts.
    const bindings = [];
    const placeholders = new Array(session.accounts.length)
        .fill(`(?, ?)`)
        .join(', ');

    // Need to create column pairs for each insertion.
    for (const account of session.accounts) {
        bindings.push(account.id, session.id);
    }

    const relationshipInsert = d1
        .prepare(
            `INSERT INTO AccountSession (
                account_id,
                session_id
            ) VALUES ${placeholders}`
        )
        .bind(...bindings);

    preparedStatements.push(relationshipInsert);

    try {
        // Batched statements are SQL transactions: if any statement
        // fails, the whole sequence aborts and rolls back.
        await d1.batch(preparedStatements);
    } catch (error: any) {
        console.error(
            '`CreateSession()` batch query error:',
            error?.message || error
        );
        throw new UnexpectedError();
    }

    return session;
}

/**
 * Returns a prepared-and-bound statement to delete a Session.
 */
export function prep_DeleteSession(d1: D1Database, sessionId: string) {
    return d1.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId);
}

/**
 * Returns a prepared-and-bound statement to delete Account-Session
 * relationships.
 *
 * NOTE: This query should be executed prior to any query to delete
 * the given Session to avoid foreign-key constraints.
 */
export function prep_DeleteAccountSession(d1: D1Database, sessionId: string) {
    return d1
        .prepare('DELETE FROM AccountSession WHERE session_id = ?')
        .bind(sessionId);
}

/**
 * Runs query to delete the Session with the given ID in the DB.
 */
export function DeleteSession(d1: D1Database, sessionId: string) {
    const stmts = [
        prep_DeleteAccountSession(d1, sessionId),
        prep_DeleteSession(d1, sessionId),
    ];

    return d1
        .batch(stmts)
        .then(batchQueryResults => {
            return batchQueryResults.every(queryResult => queryResult.success);
        })
        .catch(err => {
            console.error('`DeleteSession()` query error:', err);
            throw new UnexpectedError();
        });
}

// TODO: change this function to not use a `batch` of querires, and
// instead just send a single `JOIN` query, and loop over those rows.
//
// OH, and just `JOIN` to pull the account data, too, while we're at
// it – it doesn't make sense to only send Account IDs.
export async function GetSessionById(
    d1: D1Database,
    sessionId: string
): Promise<Session | null> {
    let queryResults;

    try {
        queryResults = await d1
            .prepare(
                `SELECT
                    accounts.id AS account_id,
                    accounts.display_name,
                    accounts.email,
                    accounts.email_verified,
                    accounts.flags,
                    accounts.image,
                    accounts.provider_name,
                    accounts.provider_client_id,
                    accounts.time_created AS account_time_created,
                    accounts.time_deleted AS account_time_deleted,
                    accounts.time_updated AS account_time_updated,
                    accounts.user_name,
                    sessions.id AS session_id,
                    sessions.ip_country,
                    sessions.time_created AS session_time_created,
                    sessions.time_expires AS session_time_expires
                FROM accounts
                JOIN AccountSession
                    ON AccountSession.account_id = accounts.id
                JOIN sessions
                    ON sessions.id = AccountSession.session_id
                WHERE AccountSession.session_id = ?;`
            )
            .bind(sessionId)
            .all();
    } catch (error: any) {
        console.error(
            '`GetSessionById()` query error:',
            error?.message || error
        );
        throw new UnexpectedError();
    }

    if (!queryResults.results.length) {
        return null;
    }

    // Process query results.
    const accounts: Array<Account> = [];
    let session: any = { accounts: accounts, fresh: false };

    for (const row of queryResults.results as any) {
        if (row.account_id) {
            // Single accounts-join-row → Account mapper, shared with the
            // bearer-credential path (`accountFromRow`). One place to map
            // a `accounts` row; neither auth path can drift from the other.
            accounts.push(accountFromRow(row));
        }

        // Only need to set these once.
        if (!session.id) {
            session.id = row.session_id;
            session.ip_country = row.ip_country;
            session.time_created = new Date(row.session_time_created * 1000);
            session.time_expires = new Date(row.session_time_expires * 1000);
        }
    }

    const parseResult = SessionSchema.safeParse(session);

    if (!parseResult.success) {
        console.error(
            '`GetSessionById()` parse error:',
            // Log the `issues` only, stringifying the `path` array.
            ...parseResult.error.issues.map(issue => ({
                ...issue,
                path: issue.path.join('/'),
            }))
        );

        throw new ParseError();
    }

    return parseResult.data;
}

function updateSessionExpiration(
    d1: D1Database,
    { sessionId, time_expires }: { sessionId: string; time_expires: Date }
) {
    return d1
        .prepare('UPDATE sessions SET time_expires = ? WHERE id = ?')
        .bind(Math.floor(time_expires.getTime() / 1000), sessionId)
        .run()
        .then(result => result.meta.changed_db)
        .catch(err => {
            console.error('`updateSessionExpiration()` query error:', err);
            throw err;
        });
}

export async function ValidateSession(d1: D1Database, sessionId: string) {
    const databaseSession = await GetSessionById(d1, sessionId);

    // If no session, return null
    if (!databaseSession) {
        return null;
    }

    // Check session expiration
    if (!isWithinExpirationDate(databaseSession.time_expires)) {
        try {
            await DeleteSession(d1, databaseSession.id);
        } catch (error) {
            console.error(
                '`ValidateSession()` error deleting expired session: "%s"',
                databaseSession.id
            );
            throw new UnexpectedError();
        }

        return null;
    }

    // The session we'll return.
    const session: Session = {
        accounts: databaseSession.accounts,
        fresh: false,
        id: databaseSession.id,
        ip_country: databaseSession.ip_country,
        time_created: databaseSession.time_created,
        time_expires: databaseSession.time_expires,
    };

    // Calculate session refresh point, which is half the full
    // expiration time.
    const refreshDate = new Date(
        databaseSession.time_expires.getTime() -
            SESSION_EXPIRATION.milliseconds() / 2
    );

    // Refresh session, if within refresh cutoff.
    if (!isWithinExpirationDate(refreshDate)) {
        session.fresh = true;
        session.time_expires = createDate(SESSION_EXPIRATION);

        try {
            await updateSessionExpiration(d1, {
                sessionId: databaseSession.id,
                time_expires: session.time_expires,
            });
        } catch (error) {
            console.error(
                '`ValidateSession()` error updating session expiration:',
                error
            );
            throw new UnexpectedError();
        }
    }

    return session;
}


// ═══ from auth/credential.ts ═══

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

    // Soft state: admit only a live credential. `credentialState` is the
    // single definition of revoked/expired/active (revoked beats expired)
    // — shared with the connected-clients read so the auth decision and
    // the management-surface badge can't disagree.
    if (
        credentialState(
            { time_revoked: row.time_revoked, time_expires: row.time_expires },
            now,
        ) !== 'active'
    ) {
        return null;
    }

    const account = accountFromRow(row);

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
 * Binding enforcement (ADR 0022 §Negative consequences, GH #20): does a
 * token with this `boundEntityId` permit acting on `entityId`?
 *
 * The single binding rule (candidate 2): does a token with this
 * `boundEntityId` permit acting on `entityId`? An unbound token (`null`)
 * permits any entity; a bound token permits exactly its own. Prefix-
 * agnostic — the id prefix (`l/`, `t/`, `w/`, `a/`) is part of the
 * compared value, so one rule covers every entity kind (ADR 0022 §4).
 *
 * This leaf is the one definition shared by the per-entity authz gate
 * (where it *enforces*) and the connected-clients read (where it
 * *narrows visibility*), so "what a token may do" and "what a manager
 * sees" can never drift apart.
 */
export function tokenBindsToEntity(
    boundEntityId: string | null,
    entityId: string,
): boolean {
    if (boundEntityId == null) return true;
    return boundEntityId === entityId;
}

/**
 * The single definition of a credential's lifecycle state (folded
 * candidate 3), over the soft-state columns. **Revoked beats expired**: a
 * revoked-and-also-past-window token reads `revoked`. Shared by
 * `VerifyBearerCredential` (admit iff `active`) and the connected-clients
 * read (the state badge), so the auth decision and the surface agree by
 * construction. Credential-only — sessions have no `revoked` state
 * (revoke deletes the row) and keep their own active/expired split.
 */
export function credentialState(
    row: { time_revoked: number | null; time_expires: number | null },
    now: number,
): 'active' | 'revoked' | 'expired' {
    if (row.time_revoked != null) return 'revoked';
    if (row.time_expires != null && row.time_expires <= now) return 'expired';
    return 'active';
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


// ═══ from auth/connected.ts ═══

/**
 * Connected-clients union read (ADR 0022 §6, GH #23).
 *
 * "What's connected" is the union of the independent grant axes. Two of
 * those axes are non-interactive principals that both live authoritatively
 * in D1 (`DJIBB_AUTH`):
 *
 *   - **sessions** — interactive sign-ins (`sessions` ⋈ `AccountSession`).
 *   - **tokens** — issued bearer credentials (`issued_credentials`, §4).
 *
 * Unlike `entity_memberships` / `entity_invitations_index`, there is **no
 * projection to emit**: neither source originates in a Durable Object, so
 * the ADR 0003 pipeline (DO-authoritative → D1 emit + ADR 0007 reconciler)
 * has nothing to copy. Both tables are already the system of record. This
 * module is therefore just the *read* that unions them, shaped to the field
 * set the #19 prototype locked in (`docs/plans/connected-clients-surface.md`).
 *
 * The third row type from #19 — **bot member-Accounts** — is NOT here: a bot
 * operates its own Account and so appears via the existing roster
 * (`entity_memberships`), not via sessions or tokens. The full surface (#24)
 * composes this read with the membership roster; keeping them separate
 * matches their separate substrates.
 */

/** The two principal kinds this read unions. Bots come from the roster. */
export type ConnectedClientKind = 'session' | 'token';

/**
 * A single connected principal, shaped to the #19 field set. Fields a given
 * kind doesn't have are `null` (sessions carry no label, binding, or
 * last-used; tokens carry all three), so the surface renders one table.
 */
export type ConnectedClient = {
    kind: ConnectedClientKind;
    /** Stable handle: the session id or the public `credential_id`. */
    id: string;
    account_id: string;
    /** Token label; `null` for sessions (the client derives a device label). */
    label: string | null;
    /** Token binding (§4); always `null` for sessions (account-wide). */
    bound_entity_id: string | null;
    time_created: number;
    /** Best-effort/throttled for tokens (§4); `null` for sessions (no column). */
    time_last_used: number | null;
    /** Absolute expiry, or `null` for a non-expiring token. */
    time_expires: number | null;
    /**
     * `active` rows belong in the roster; `revoked`/`expired` belong in the
     * history view. A revoked session doesn't exist (revoke deletes the row),
     * so sessions are only ever `active` or `expired`.
     */
    state: 'active' | 'revoked' | 'expired';
};

type SessionRow = {
    id: string;
    account_id: string;
    time_created: number;
    time_expires: number;
};

type CredentialRow = {
    credential_id: string;
    account_id: string;
    label: string | null;
    bound_entity_id: string | null;
    time_created: number;
    time_last_used: number | null;
    time_expires: number | null;
    time_revoked: number | null;
};

/** `?,?,?` for an IN-list of `n` bound params. */
function placeholders(n: number): string {
    return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * The unioned connected view for one or more Accounts, optionally narrowed
 * to a single entity.
 *
 * Scope is Account-keyed because both substrates are: a session belongs to
 * an Account (`AccountSession`), a credential is minted for one
 * (`issued_credentials.account_id`). The entity surface (#24) resolves the
 * relevant member Accounts (via `entity_memberships`) and passes them here.
 *
 * When `entityId` is given, tokens **bound to a different entity** are
 * dropped — a bound token cannot act on any entity but its own (the §20
 * rule, applied here as visibility). Unbound tokens and all sessions are
 * Account-wide and always included.
 *
 * Revoked/expired rows are returned (not filtered) so the caller can split
 * the active roster from the history view by `state`.
 */
export async function ListConnectedClients(
    d1: D1Database,
    args: {
        accountIds: readonly string[];
        /** Narrow tokens to this entity (unbound + bound-to-it). Sessions unaffected. */
        entityId?: string;
        /** Override "now" (unix seconds) for deterministic tests. */
        now?: number;
    },
): Promise<ConnectedClient[]> {
    const accountIds = [...new Set(args.accountIds)];
    if (accountIds.length === 0) return [];

    const now = args.now ?? Math.floor(Date.now() / 1000);
    const ph = placeholders(accountIds.length);

    const [sessions, credentials] = await Promise.all([
        d1
            .prepare(
                `SELECT s.id AS id,
                        a.account_id AS account_id,
                        s.time_created AS time_created,
                        s.time_expires AS time_expires
                 FROM sessions s
                 JOIN AccountSession a ON a.session_id = s.id
                 WHERE a.account_id IN (${ph});`,
            )
            .bind(...accountIds)
            .all<SessionRow>(),
        d1
            .prepare(
                `SELECT credential_id, account_id, label, bound_entity_id,
                        time_created, time_last_used, time_expires, time_revoked
                 FROM issued_credentials
                 WHERE account_id IN (${ph});`,
            )
            .bind(...accountIds)
            .all<CredentialRow>(),
    ]);

    const out: ConnectedClient[] = [];

    for (const s of sessions.results ?? []) {
        out.push({
            kind: 'session',
            id: s.id,
            account_id: s.account_id,
            label: null,
            bound_entity_id: null,
            time_created: s.time_created,
            time_last_used: null,
            time_expires: s.time_expires,
            state: s.time_expires <= now ? 'expired' : 'active',
        });
    }

    for (const c of credentials.results ?? []) {
        // Entity narrowing via the *same* binding leaf the authz gate
        // enforces (`tokenBindsToEntity`): a token that can't act here
        // isn't "connected" here, by construction — visibility and
        // enforcement can't drift. Unbound tokens are account-wide.
        if (
            args.entityId != null &&
            !tokenBindsToEntity(c.bound_entity_id, args.entityId)
        ) {
            continue;
        }

        out.push({
            kind: 'token',
            id: c.credential_id,
            account_id: c.account_id,
            label: c.label,
            bound_entity_id: c.bound_entity_id,
            time_created: c.time_created,
            time_last_used: c.time_last_used,
            time_expires: c.time_expires,
            // Same liveness leaf VerifyBearerCredential admits on, so the
            // badge and the auth decision are one judgment.
            state: credentialState(c, now),
        });
    }

    return out;
}

/** Display fields for the Account a connected client "acts as". */
export type AccountDisplay = {
    account_id: string;
    display_name: string;
    email: string | null;
};

/**
 * Resolve display fields for a set of Accounts so the surface can render
 * "acts as <name>" instead of a raw id (#19 open question 2, the Account
 * half). Returns a map keyed by `account_id`; missing accounts are simply
 * absent (the caller falls back to the id).
 */
export async function ResolveAccountDisplays(
    d1: D1Database,
    accountIds: readonly string[],
): Promise<Map<string, AccountDisplay>> {
    const ids = [...new Set(accountIds)];
    const out = new Map<string, AccountDisplay>();
    if (ids.length === 0) return out;

    const rows = await d1
        .prepare(
            `SELECT id AS account_id, display_name, email
             FROM accounts
             WHERE id IN (${placeholders(ids.length)});`,
        )
        .bind(...ids)
        .all<AccountDisplay>();

    for (const r of rows.results ?? []) out.set(r.account_id, r);
    return out;
}

/**
 * Resolve `credential_id → label` for mutation-log attribution (§5, #24):
 * the audit view renders "via <label>" for entries authored under a token.
 * Labels are returned for any matching credential regardless of
 * revoked/expired state — history entries still attribute to the (now-dead)
 * client that wrote them. A `null` label (token minted without one) maps to
 * `null`; the renderer falls back to the bare `credential_id`.
 */
export async function ResolveCredentialLabels(
    d1: D1Database,
    credentialIds: readonly string[],
): Promise<Map<string, string | null>> {
    const ids = [...new Set(credentialIds)];
    const out = new Map<string, string | null>();
    if (ids.length === 0) return out;

    const rows = await d1
        .prepare(
            `SELECT credential_id, label
             FROM issued_credentials
             WHERE credential_id IN (${placeholders(ids.length)});`,
        )
        .bind(...ids)
        .all<{ credential_id: string; label: string | null }>();

    for (const r of rows.results ?? []) out.set(r.credential_id, r.label);
    return out;
}

/**
 * Split a connected-clients list into the active roster and the
 * revoked/expired history, per the #19 two-section layout. A thin
 * convenience over `state` so every caller partitions the same way.
 */
export function partitionConnectedClients(clients: readonly ConnectedClient[]): {
    active: ConnectedClient[];
    history: ConnectedClient[];
} {
    const active: ConnectedClient[] = [];
    const history: ConnectedClient[] = [];
    for (const c of clients) {
        (c.state === 'active' ? active : history).push(c);
    }
    return { active, history };
}
