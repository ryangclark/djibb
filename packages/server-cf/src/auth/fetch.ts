import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';

import type { HonoEnv } from '..';
import {
    BaseSessionCookieAttributes,
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
} from './magic';
import { CreateSession, DeleteSession } from './session';
import type { Account } from '@djibb/protocol/account';

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

        setCookie(c, CookieNames.Session, '', BaseSessionCookieAttributes);

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

    setCookie(c, CookieNames.Session, session.id, BaseSessionCookieAttributes);

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
