import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';

import { HonoEnv } from '..';
import {
    BaseSessionCookieAttributes,
    CookieNames,
    OAUTH_REDIRECT_URI,
} from './constants';
import { UnauthenticatedError, UnexpectedError } from '../errors';
import { HandleSession } from './middleware';
import {
    handleGetMockSession,
    handleInitOAuthGoogle,
    handleVerifyOAuthGoogle,
} from './oauth';
import { CreateSession, DeleteSession } from './session';

export const Auth_App = new Hono<HonoEnv>();

Auth_App.use('*', HandleSession);

Auth_App.get('/djibb', handleGetMockSession);

Auth_App.get('/google', handleInitOAuthGoogle);
Auth_App.get(OAUTH_REDIRECT_URI.google, handleVerifyOAuthGoogle);

Auth_App.delete('/session/accounts', async c => {
    let session = c.get('session');
    if (!session) throw new UnauthenticatedError();

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
    const indexOf = session.accounts.findIndex(
        account => account.id === parseResult.data.account_id
    );

    if (indexOf < 0) {
        console.warn(
            'Handle delete AccountSession error: requested Account ID "%s" not tied to Session ID "%s".',
            parseResult.data.account_id,
            session.id
        );

        return new Response('invalid request data', { status: 403 });
    }

    // As of now, if you don't have an account, you don't have a session.
    if (session.accounts.length === 1) {
        try {
            const result = await DeleteSession(c.env.DJIBB_AUTH, session.id);

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

    const newAccounts = [...session.accounts];
    newAccounts.splice(indexOf, 1);

    // TODO: rate-limit this.

    try {
        // Create the session.
        session = await CreateSession(
            c.env.DJIBB_AUTH,
            {
                accounts: newAccounts,
                ip_country: c.req.header('CF-IPCountry') || '',
            },
            session.id
        );
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, BaseSessionCookieAttributes);

    return c.json(session);
});

Auth_App.get('/session', async c => {
    const session = c.get('session');
    if (!session) {
        throw new UnauthenticatedError();
    }

    return c.json(session);
});
