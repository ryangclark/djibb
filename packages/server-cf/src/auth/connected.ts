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
import { credentialState, tokenBindsToEntity } from './credential';

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
