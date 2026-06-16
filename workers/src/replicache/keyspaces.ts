import type { PatchOperation } from 'replicache';

import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import type { AuthorizationRole } from '@djibb/protocol/auth/rules';

/**
 * Per-role hidden state in Replicache pulls (ADR 0009 §"PII gating
 * via pull filter").
 *
 * The unit of redaction is a **Replicache key prefix** — a
 * "keyspace." Every patch op has a `key` like `"l/abc..."`,
 * `"i/def..."`, or `"pending_invites/bob@x.com"`. The prefix before
 * the `/` declares which keyspace the row belongs to. A keyspace is
 * the bridge between the prefix and its DO sql source, gated by a
 * role predicate:
 *
 *   - `visibleTo(role)` — predicate. When false, the prefix is
 *     entirely hidden from this role's pulls.
 *   - `readChanges(sql, prevVersion)` — emit put/del ops for rows
 *     whose `version > prevVersion`. Soft-deleted rows become `del`
 *     ops so revocation surfaces to clients that previously cached
 *     the row.
 *   - `listAllCurrentKeys(sql)` — enumerate every live key in the
 *     keyspace. Used only on **role demotion** (the previous pull
 *     saw the keyspace, this pull doesn't): the handler emits `del`
 *     ops for each, evicting the cached state from Replicache.
 *
 * The pattern generalizes — any future per-role hidden state
 * (`audit_trail/`, owner-only annotations, moderator soft-delete
 * views) becomes one more entry in a DO subclass's keyspaces array,
 * not a new branch in the pull handler.
 *
 * Adding a keyspace: implement the three fields against your DO's
 * sql, append the entry to your DO subclass's `PULL_KEYSPACES` array
 * (e.g., `LIST_PULL_KEYSPACES` in `workers/src/list/pull.ts`), and
 * write a direct pull test asserting non-visible roles do not see
 * the prefix.
 */
export type Keyspace = {
    /** Display name for logs / debugging. Distinct from `keyPrefix`. */
    name: string;
    /**
     * Replicache key prefix (without trailing slash) for this
     * keyspace's keys. Convention: `<prefix>/<row-id>`.
     */
    keyPrefix: string;
    /** Visibility predicate. False ⇒ keyspace is hidden from this role. */
    visibleTo: (role: AuthorizationRole) => boolean;
    /**
     * Diff against `prevVersion`. Returns Replicache patch ops with
     * fully-qualified keys (`<keyPrefix>/<id>`). Both `op:'put'`
     * (live row) and `op:'del'` (tombstoned row) entries belong here
     * — the keyspace owns the policy for what its `del` semantics
     * mean.
     */
    readChanges: (
        sql: SqlStorage,
        prevVersion: number
    ) => readonly PatchOperation[];
    /**
     * Enumerate every live key currently in this keyspace. Called
     * on role demotion to emit per-key `del` ops; the result needn't
     * be sorted.
     */
    listAllCurrentKeys: (sql: SqlStorage) => readonly string[];
};

// ---------- Cookie codec ----------

/**
 * Normalized cookie. The wire shape may be `null`, a bare number
 * (legacy: just entity version), or `{v, r}`. We always emit the
 * object form going forward; the parser tolerates legacy inputs so
 * in-flight clients keep working through the transition.
 */
export type PullCookie = {
    /** Entity version the requester last pulled at. 0 = fresh. */
    v: number;
    /**
     * Role the requester held at last pull. `null` for legacy cookies
     * (we don't know the prior role) and for from-scratch pulls.
     */
    r: AuthorizationRole | null;
};

/**
 * Cookie parser. Accepts:
 *   - `null` / `undefined`              ⇒ `{v:0, r:null}` (fresh pull)
 *   - `{v, r}` (canonical shape)        ⇒ as-is, role validated
 *   - anything else                     ⇒ `{v:0, r:null}` (defensive)
 *
 * `r` is run through the role enum's safe parse so a tampered cookie
 * can't smuggle in an unknown role string. Unknown role ⇒ null
 * (treated as "we don't know what they had"), which means demotion
 * eviction won't fire — fail-closed for the live keyspace check,
 * fail-open for the eviction. Reasonable: a viewer-presenting cookie
 * with a smuggled "owner" role doesn't get owner-only data because
 * the visibility check runs against the *current* role from the
 * authoritative request, not the cookie's r.
 */
export function parsePullCookie(cookie: unknown): PullCookie {
    if (cookie == null) return { v: 0, r: null };
    if (typeof cookie === 'object') {
        const obj = cookie as Record<string, unknown>;
        const v = typeof obj.v === 'number' && Number.isFinite(obj.v) ? obj.v : 0;
        const rRaw = obj.r;
        if (rRaw == null) return { v, r: null };
        const rParse = AuthorizationRoleEnum.safeParse(rRaw);
        return { v, r: rParse.success ? rParse.data : null };
    }
    return { v: 0, r: null };
}

export function encodePullCookie(cookie: PullCookie): PullCookie & {
    order: number;
} {
    // Replicache V1 protocol validates object cookies by requiring an
    // `order` field of type string|number — see the puller validator
    // `en()` in `replicache/out/chunk-*.js`. Without it, every pull
    // response is rejected with "Invalid puller result" and the client
    // never advances past the initial v0 fresh-pull (the first one is
    // accepted because `cookie === null` IS valid). Use the entity
    // version `v` as `order`: it's monotonically increasing per pull,
    // which is exactly what Replicache wants for cookie ordering.
    //
    // The in-memory parser ignores extra fields, so adding `order`
    // here is wire-only and doesn't perturb anything that reads the
    // cookie back.
    return { ...cookie, order: cookie.v };
}

// ---------- Orchestration ----------

/**
 * Compute the patch contributions of a keyspaces list for one pull
 * request. Returns ops in stable iteration order (keyspaces array
 * order, then each keyspace's own readChanges order).
 *
 * Three role transitions matter, decided per keyspace:
 *
 *   1. Currently visible AND was visible last pull (or first pull):
 *      normal diff — emit changes since `previousVersion`.
 *   2. Currently visible AND was NOT visible last pull (promotion):
 *      emit changes since version 0 — the requester needs every
 *      live row, not just the diff, because their last cache had
 *      none.
 *   3. Currently NOT visible AND WAS visible last pull (demotion):
 *      emit `del` for every key the keyspace currently has, so
 *      Replicache evicts the cached state.
 *
 * The fourth (not visible, never was) is a no-op — nothing to add.
 *
 * Role-unknown previous (legacy bare-number cookie or fresh pull):
 * promotion can't be detected — handled by the from-scratch flag the
 * caller passes when `previousVersion === 0` (the pull handler
 * already emits `op:'clear'` in that case, so a normal diff suffices).
 */
export function appendKeyspacePatches({
    keyspaces,
    sql,
    currentRole,
    previousRole,
    previousVersion,
}: {
    keyspaces: readonly Keyspace[];
    sql: SqlStorage;
    currentRole: AuthorizationRole;
    previousRole: AuthorizationRole | null;
    previousVersion: number;
}): PatchOperation[] {
    const out: PatchOperation[] = [];
    for (const ks of keyspaces) {
        const isVisible = ks.visibleTo(currentRole);
        const wasVisible =
            previousRole != null ? ks.visibleTo(previousRole) : false;

        if (isVisible && wasVisible) {
            // Normal diff.
            out.push(...ks.readChanges(sql, previousVersion));
        } else if (isVisible && !wasVisible) {
            // Promotion: full sync as if from-scratch for this
            // keyspace. previousVersion=0 makes readChanges emit
            // every live row.
            out.push(...ks.readChanges(sql, 0));
        } else if (!isVisible && wasVisible) {
            // Demotion: evict the cached keyspace.
            for (const key of ks.listAllCurrentKeys(sql)) {
                out.push({ op: 'del', key });
            }
        }
        // (!isVisible && !wasVisible) ⇒ no-op
    }
    return out;
}
