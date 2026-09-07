import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';

import type { HonoEnv } from '..';
import {
    sessionCookieAttributes,
    CookieNames,
    OAUTH_REDIRECT_URI,
} from './constants';
import { UnauthenticatedError, UnexpectedError } from '@djibb/protocol/errors';
import { HandleSession } from './middleware';
import {
    handleGetMockSession,
    handleInitOAuthGoogle,
    handleVerifyOAuthGoogle,
} from './oauth';
import {
    handleMagicConsume,
    handleMagicLand,
    handleMagicRequest,
    handleSudoRequest,
} from './magic';
import {
    handleConnectConsent,
    handleConnectConsentSubmit,
    handleConnectToken,
} from './connect';
import {
    CreateSession,
    DeleteSession,
    GetSessionSudo,
    SoftDeleteAccountPhase1,
} from './d1';
import type { Account } from '@djibb/protocol/account';

/**
 * Sudo-mode freshness window (GH #58). A destructive account action is
 * admitted only within this many seconds of a completed step-up re-auth.
 * GitHub-ish: long enough to finish the flow, short enough that a walked-
 * away session goes stale.
 */
const SUDO_WINDOW_SECONDS = 5 * 60;

export const Auth_App = new Hono<HonoEnv>();

Auth_App.use('*', HandleSession);

Auth_App.get('/djibb', handleGetMockSession);

Auth_App.get('/google', handleInitOAuthGoogle);
Auth_App.get(OAUTH_REDIRECT_URI.google, handleVerifyOAuthGoogle);

// Magic-link auth (ADR 0010). /request mints + emails, /land renders
// the interstitial click-through page, /consume validates and signs in.
Auth_App.post('/magic/request', handleMagicRequest);
Auth_App.get('/magic/land', handleMagicLand);
Auth_App.post('/magic/consume', handleMagicConsume);

// Connect ceremony disclosure interstitial (ADR 0024 §3, GH #29). The
// worker-owned page that discloses the connection being made *before* any code
// is minted. GET renders (idempotent, non-consuming); POST is the affirmative
// decision — submitting the single Connect form mints the code and redirects.
// v1 is affirmative-only: there is no decline button (closing the page mints
// nothing, which is the real "no"; see ADR 0024's §3 amendment). The POST is
// CSRF-exempt (see src/index.ts): it posts from this page whose Origin is the
// API origin, and its authenticity is the single-use `pending` handle only the
// ceremony browser holds.
Auth_App.get('/connect/consent', handleConnectConsent);
Auth_App.post('/connect/consent', handleConnectConsentSubmit);

// Connect ceremony token endpoint (ADR 0024 §1, GH #28). Exchanges a
// single-use authorization code + PKCE verifier for a bearer credential.
// CSRF-exempt (see src/index.ts) — its authenticity is the body-carried
// code + verifier, like /magic/consume.
Auth_App.post('/connect/token', handleConnectToken);

// Sudo-mode step-up (ADR 0024 §3 withdraw path, GH #58). Session-only;
// mints+emails a fresh re-auth link that stamps this session sudo-fresh
// on consume. Posted from the first-party settings UI (Origin in
// AUTHORIZED_DOMAINS), so it stays under the normal CSRF Origin check —
// unlike /magic/consume, it is NOT exempt.
Auth_App.post('/sudo/request', handleSudoRequest);

// Account (identity) deletion — Phase 1 (ADR 0024 §3 withdraw path, GH
// #58). Immediate soft-delete + synchronous hard-revoke of every session,
// credential, and pending-auth handle for the identity. Session-only (a
// bearer credential must never delete the identity it is scoped to) and
// gated behind a fresh sudo step-up for *this same account*.
Auth_App.post('/account/delete', async c => {
    const principal = c.get('principal');
    // Session-only, mirroring `DELETE /session/accounts`: a bearer
    // credential has no session and must never be a self-destruct button.
    if (principal.kind !== 'session') throw new UnauthenticatedError();

    const requestBody = await c.req.json().catch(() => null);
    const parseResult = z
        .object({ account_id: z.string() })
        .safeParse(requestBody);
    if (!parseResult.success) {
        return new Response('invalid request data', { status: 400 });
    }
    const accountId = parseResult.data.account_id;

    // The account must be one this session holds.
    const account = principal.accounts.find(a => a.id === accountId);
    if (!account) {
        return new Response('invalid request data', { status: 403 });
    }

    // Sudo gate: the calling session must have completed a step-up re-auth
    // for THIS account inside the freshness window. Account-precise, so a
    // multi-account session's sudo for one identity can't delete another.
    const now = Math.floor(Date.now() / 1000);
    const sudo = await GetSessionSudo(c.env.DJIBB_AUTH, principal.sessionId);
    const sudoFresh =
        sudo?.time_sudo != null &&
        sudo.sudo_account_id === accountId &&
        now - sudo.time_sudo <= SUDO_WINDOW_SECONDS;
    if (!sudoFresh) {
        return c.json({ error: 'sudo_required' }, 403);
    }

    const callerSingleAccount = principal.accounts.length === 1;

    try {
        await SoftDeleteAccountPhase1(c.env.DJIBB_AUTH, {
            accountId,
            email: account.email ? account.email.toLowerCase() : null,
            now,
        });
    } catch (error) {
        console.error('`POST /account/delete` cascade error:', error);
        throw new UnexpectedError();
    }

    if (callerSingleAccount) {
        // The caller's own (single-account) session was just deleted — clear
        // its cookie and report signed-out.
        setCookie(c, CookieNames.Session, '', sessionCookieAttributes(c));
        return new Response(null, { status: 204 });
    }

    // A multi-account session survives with the deleted account removed in
    // place (same session id, cookie unchanged). Report the remaining set.
    const remaining = principal.accounts.filter(a => a.id !== accountId);
    return c.json({ accounts: remaining });
});

Auth_App.delete('/session/accounts', async c => {
    // Inherently session-only: this mutates the cookie session (drops an
    // Account, re-mints). A bearer credential has no session to edit.
    const principal = c.get('principal');
    if (principal.kind !== 'session') throw new UnauthenticatedError();
    let sessionId = principal.sessionId;
    let accounts: readonly Account[] = principal.accounts;

    // Now get the requested Account ID.
    const requestBody = await c.req.json().catch(error => {
        console.error(
            'Handle delete AccountSession error: bad request body. Error:',
            error
        );

        return null;
    });

    const parseResult = z
        .object({ account_id: z.string() })
        .safeParse(requestBody);

    if (!parseResult.success) {
        console.warn(
            'Handle delete AccountSession warning: bad request data. Error:',
            parseResult.error.format()
        );
        return new Response('invalid request data', { status: 400 });
    }

    // Check that the requested Account is tied to the Session.
    const indexOf = accounts.findIndex(
        account => account.id === parseResult.data.account_id
    );

    if (indexOf < 0) {
        console.warn(
            'Handle delete AccountSession error: requested Account ID "%s" not tied to Session ID "%s".',
            parseResult.data.account_id,
            sessionId
        );

        return new Response('invalid request data', { status: 403 });
    }

    // As of now, if you don't have an account, you don't have a session.
    if (accounts.length === 1) {
        try {
            const result = await DeleteSession(c.env.DJIBB_AUTH, sessionId);

            if (!result) {
                // Throwing error here out of caution.
                throw new UnexpectedError();
            }
        } catch (error) {
            throw new UnexpectedError();
        }

        setCookie(c, CookieNames.Session, '', sessionCookieAttributes(c));

        return new Response(null, { status: 204 });
    }

    const newAccounts = [...accounts];
    newAccounts.splice(indexOf, 1);

    // TODO: rate-limit this.

    let session;
    try {
        // Create the session.
        session = await CreateSession(
            c.env.DJIBB_AUTH,
            {
                accounts: newAccounts,
                ip_country: c.req.header('CF-IPCountry') || '',
            },
            sessionId
        );
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, sessionCookieAttributes(c));

    return c.json(session);
});

Auth_App.get('/session', async c => {
    // The frontend reads only `accounts` (and treats 401 as signed-out).
    // A bearer credential is a single-Account principal too, so this
    // answers "who am I" for any authed client.
    const principal = c.get('principal');
    if (principal.kind === 'anonymous') {
        throw new UnauthenticatedError();
    }

    return c.json({ accounts: principal.accounts });
});
