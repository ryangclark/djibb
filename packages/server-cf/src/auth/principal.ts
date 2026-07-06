/**
 * The request→Account seam (ADR 0022 §2).
 *
 * Every client — the browser's session cookie, the CLI's bearer token,
 * and the weird clients to come (email-reply, standing bots) — funnels
 * through one resolution and comes out as a single {@link RequestPrincipal}.
 * Downstream code reads that one value; it never reassembles "who is
 * acting, as what credential, bound where" from scattered context vars.
 *
 * `RequestPrincipal` is a *sibling* model, not a subtype one: a `session`
 * and a `credential` are peers (different substrate, lifecycle, and
 * cardinality), converging only here. The shared `accounts` field is the
 * one thing every authed reader wants ("which Accounts may this request
 * act as"); the discriminant carries only what each arm uniquely has —
 * `sessionId` for the cookie-merge flow, `credentialId` + `boundEntityId`
 * (and, later, a role ceiling) for the forward-threaded credential
 * constraints the seam itself cannot enforce.
 *
 * `resolvePrincipal` is deliberately context-free (no Hono `Context`): it
 * is the testable surface for the precedence rules. The middleware
 * (`HandleSession`) is a thin adapter that reads the cookie/header off the
 * request, calls this, applies the returned cookie directive, and sets the
 * `principal` var. `resolveRole` (`auth/resolver.ts`) stays untouched — a
 * principal acts at its Account's resolved role exactly as before.
 */
import type { Account } from '@djibb/protocol/account';
import { ValidateSession } from './d1';
import { VerifyBearerCredential } from './d1';

/**
 * Who a request resolves to. The two authed arms share `accounts` (a
 * credential's is length-1); each carries only its own distinguishing
 * fields. `anonymous` has no accounts.
 */
export type RequestPrincipal =
    | { kind: 'anonymous' }
    | { kind: 'session'; accounts: readonly Account[]; sessionId: string }
    | {
          kind: 'credential';
          accounts: readonly Account[];
          credentialId: string;
          boundEntityId: string | null;
      };

/**
 * What the middleware should do to the session cookie after resolution.
 * `refresh` re-sets it (a mid-life session was extended), `clear` blanks a
 * stale/invalid cookie, `none` leaves it alone (bearer/anonymous paths
 * never touch the cookie). Demoted here from the old `Session.fresh` flag:
 * `fresh` was only ever consumed to drive this directive, so it lives here
 * rather than leaking onto the public principal.
 */
export type CookieDirective = 'none' | 'refresh' | 'clear';

export type PrincipalResolution = {
    principal: RequestPrincipal;
    cookie: CookieDirective;
};

const ANONYMOUS: PrincipalResolution = {
    principal: { kind: 'anonymous' },
    cookie: 'none',
};

/**
 * The Accounts a request may act as: both authed arms' `accounts`, or `[]`
 * for anonymous. The common read for every consumer that doesn't care
 * which arm authenticated (most of them) — replaces the old
 * `session?.accounts ?? []`.
 */
export function principalAccounts(p: RequestPrincipal): readonly Account[] {
    return p.kind === 'anonymous' ? [] : p.accounts;
}

/**
 * The acting credential id for attribution (ADR 0022 §5), or `null` for
 * session/anonymous requests — the value threaded onto the mutation
 * outcome record.
 */
export function actingCredentialId(p: RequestPrincipal): string | null {
    return p.kind === 'credential' ? p.credentialId : null;
}

/**
 * Resolve a request to a {@link RequestPrincipal}.
 *
 * Precedence (load-bearing):
 *   1. A non-blank session cookie is tried first. If it validates →
 *      `session` arm; the bearer header is **never consulted**. If it does
 *      not validate → `anonymous` with `cookie: 'clear'`; we do **not**
 *      fall through to the bearer (a stale browser cookie must not be
 *      silently upgraded into API auth).
 *   2. Only an absent/blank cookie tries the bearer header. A valid token
 *      → `credential` arm; anything else → `anonymous`.
 *
 * The substrate functions stay ignorant of `RequestPrincipal`: this is the
 * one adapter from `Session` / `ResolvedCredential` into the union.
 */
export async function resolvePrincipal(
    d1: D1Database,
    input: {
        sessionId: string | null;
        bearerToken: string | null;
        waitUntil?: (promise: Promise<unknown>) => void;
    },
): Promise<PrincipalResolution> {
    // A blank ("") cookie counts as absent — falls through to bearer.
    if (input.sessionId) {
        const session = await ValidateSession(d1, input.sessionId);
        if (!session) {
            // Present but invalid: blank the cookie, stay anonymous,
            // never try the bearer.
            return { principal: { kind: 'anonymous' }, cookie: 'clear' };
        }
        return {
            principal: {
                kind: 'session',
                accounts: session.accounts,
                sessionId: session.id,
            },
            cookie: session.fresh ? 'refresh' : 'none',
        };
    }

    if (input.bearerToken) {
        const resolved = await VerifyBearerCredential(d1, input.bearerToken, {
            waitUntil: input.waitUntil,
        });
        if (resolved) {
            return {
                principal: {
                    kind: 'credential',
                    accounts: [resolved.account],
                    credentialId: resolved.credential_id,
                    boundEntityId: resolved.bound_entity_id,
                },
                cookie: 'none',
            };
        }
    }

    return ANONYMOUS;
}
