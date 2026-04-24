import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PushRequestV1 } from 'replicache';

import { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import { AuthorizationRole, AuthorizationRoleEnum } from '../auth/rules';

import {
    DjibbError,
    ParseError,
    UnexpectedError,
    ValidationError,
} from '../errors';
import { UnauthorizedError } from '../auth/errors';
import { ReplicachePullRequestSchema } from '../replicache';
import { z } from 'zod';
import { tryCatch } from '../utils/trycatch';
import { IdTypes } from '../id';

/**
 * The shape of the Hono context for use in List Hono app `list_app`.
 *
 * For example:
 *
 *      new Hono<list_context>();
 * and:
 *
 *      function myExampleFunction(c: Context<list_context>) { ... }
 */

/**
 * This is the sub-router to handle List-related requests by invoking
 * the Durable Object for the request's List ID.
 * @see https://hono.dev/api/routing#grouping
 */
export const list_app = new Hono<HonoEnv>();

/**
 * Middleware for all requests to this sub-router that gets the
 * Durable Object stub for the request's List ID, which is given via
 * `l` search param (like how YouTube does it).
 *
 * We expect a request to be something like `GET /list?l=my-list-id` or
 * `POST /list/pull?l=my-list-id`.
 */
list_app.use('*', async (c, next) => {
    const query_param_list_id = c.req.query('l');

    if (!query_param_list_id) {
        console.log('missing query_param_list_id!');

        throw new HTTPException(400, {
            message:
                'missing `l` search query parameter to identify requested list',
        });
    }

    let prefixedId = query_param_list_id.startsWith(IdTypes['list'] + '/')
        ? query_param_list_id
        : `${IdTypes['list']}/${query_param_list_id}`;

    // Create a `DurableObjectId` using the List ID query param.
    // The ID refers to a unique instance of the `DjibbList`
    // class in this file.
    const durable_object_id: DurableObjectId =
        c.env.DJIBB_LIST.idFromName(prefixedId);

    c.set('id', durable_object_id);

    // This stub creates a communication channel with the Durable
    // Object instance. The Durable Object constructor will be
    // invoked upon the first call for a given id.
    const stub = c.env.DJIBB_LIST.get(durable_object_id);

    if (!stub) {
        console.error('no DJIBB_LIST stub!');
        throw new UnexpectedError();
    }

    c.set('list', stub);

    await next();
});

// Authentication middleware to pull session data tied to the requests'
// cookie, if any.
list_app.use('*', HandleSession);

/**
 * Authorization middleware to check whether the current DjibbList
 * Durable Object has authorization requirements, and if the current
 * request meets them.
 *
 * Authentication: Verifies who you are.
 * Authorization: Determines what you can do.
 * We're doing Authorization here.
 */
list_app.use(async (c, next) => {
    // Get authorization rules. If there aren't any yet, then the method
    // call will generate the default rules, so we pass the active
    // Account ID, if any, to inform their creation.
    const authorizationRules = await c.get('list').getAuthorizationRules();

    // Eval rules.
    let authRole: AuthorizationRole | undefined;

    // First, check the session's authorized accounts against the
    // List's authed accounts.
    for (const authedAccount of c.get('session')?.accounts || []) {
        if (authorizationRules.authorized_accounts[authedAccount.id]) {
            // If we already have an `authRole` and we've found a second
            // account with a role for this list, then we don't know
            // which account should be the "active" one. We'll need to
            // handle this eventually (see more in the comment below).
            if (authRole) {
                /**
                 * @TODO:
                 *
                 * A single session can have multiple accounts, and what happens
                 *  when more than one of those accounts is authed for a single list?
                 *  Need to have UI to pick the appropriate account, as well as a way
                 *  to store/remember that selection for the future.
                 *
                 * Could store that info on the session, the list, the user, the Replicache
                 * Client Group, etc. or some combination.
                 */

                console.error(
                    'ERR: auth/multiple-authed-accounts: a single session has multiple authed accounts for the same list'
                );
                throw new UnexpectedError();
            }

            authRole =
                authorizationRules.authorized_accounts[authedAccount.id]?.role;
        }
    }

    /**
     * @TODO: check for membership in the List's Workspace.
     * If membership confirmed, assign Workspace role, if any.
     */
    // if (!authRole) {
    //     // check for Workspace role here
    // }

    if (!authRole) {
        // Not an authorized user. Use generic role.
        authRole = authorizationRules.default_role;
    }

    c.set('authorized_role', authRole);

    await next();
});

// idk, i'd prefer this to be `/list/my-list-id` than `/list?l=my-list-id` but here we are
// would need to change middleware probably
list_app.get('', async c => {
    const listId = c.get('list').name;

    if (!listId) throw new UnexpectedError('invalid listId');

    const { data: list, error } = await c.get('list').getList({ listId });

    if (error) {
        return new Response(
            JSON.stringify({
                code: error.code,
                error: error.name,
                message: error.message,
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: error.httpStatusCode,
            }
        );
    }
    return c.json(list);
});

list_app.post('/pull', async c => {
    const json = await c.req.json().catch(() => {
        throw new ParseError();
    });

    const parse_result = ReplicachePullRequestSchema.safeParse(json);

    if (!parse_result.success) {
        console.log(
            'invalid PullRequest body:',
            z.formatError(parse_result.error)
        );
        throw new ValidationError('invalid JSON value(s)');
    }

    // Get the "name" which is the nano id used to create the super
    // long Durable Object hex id, and we now swap it back.
    const listId = c.get('list').name;
    if (!listId) throw new UnexpectedError('invalid listId');

    const listStub = c.get('list');
    const { data: list, error } = await listStub.handlePull({
        authorizedRole: c.get('authorized_role'),
        listId,
        pullRequest: parse_result.data,
    });

    if (error) {
        return new Response(
            JSON.stringify({
                code: error.code,
                error: error.name,
                message: error.message,
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: error.httpStatusCode,
            }
        );
    }

    return c.json(list);
});

list_app.post('/push', async c => {
    const pushRequest = (await c.req.json().catch(() => {
        throw new ValidationError();
    })) as PushRequestV1;

    const requestRole = c.get('authorized_role');
    const authorizedRoles = AuthorizationRoleEnum.extract([
        AuthorizationRoleEnum.enum.admin,
        AuthorizationRoleEnum.enum.checker,
        AuthorizationRoleEnum.enum.editor,
        AuthorizationRoleEnum.enum.owner,
        AuthorizationRoleEnum.enum.ownerless,
    ]);

    if (!authorizedRoles.safeParse(requestRole).success) {
        console.log('/push throw unauth!');
        throw new UnauthorizedError();
    }

    // Get the "name" which is the nano id used to create the super
    // long Durable Object hex id, and we now swap it back.
    const listId = c.get('list').name;
    if (!listId) throw new UnexpectedError('invalid listId');

    const { error } = await c.get('list').handlePush({
        authorizedAccounts: c.get('session')?.accounts || [],
        authorizedRole: c.get('authorized_role'),
        listId,
        pushRequest,
    });

    if (error) {
        return new Response(
            JSON.stringify({
                code: error.code,
                error: error.name,
                message: error.message,
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: error.httpStatusCode,
            }
        );
    }

    // Replicache ignores any response body to the `push` endpoint.
    return new Response(null, { status: 200 });
});

list_app.get('/websocket', async c => {
    const requestRole = c.get('authorized_role');

    // So websocket connections currently receive "poke" updates, which
    // tell Replicache to trigger a pull. So, a websocket connection
    // only requires a "view" permission. Update as needed.
    const authorizedRoles = AuthorizationRoleEnum.exclude([
        AuthorizationRoleEnum.enum.restricted,
    ]);

    if (!authorizedRoles.safeParse(requestRole).success) {
        throw new UnauthorizedError();
    }

    // Use `fetch` for WebSocket because we're returning a Response
    // that isn't serializable.
    return c.get('list').fetch(c.req.raw);
});

list_app.onError(err => {
    if (err instanceof DjibbError) {
        return new Response(
            JSON.stringify({
                code: err.code,
                error: err.name,
                message: err.message,
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: err.httpStatusCode,
            }
        );
    } else if (err instanceof HTTPException) {
        // Keep throwing. Hono will handle.
        throw err;
    }

    console.error('`list_app.onError()` unhandled err:', err);
    return new Response(null, {
        status: 500,
        statusText: 'Internal Server Error',
    });
});

/** @UPGRADE: Create List endpoint
 *
 * There is a chance that we could have collisions in the List ID.
 * Statistically, I think that's quite unlikely. But I have worried
 * about it, so here's an idea for a way to prevent such collisions
 * when the client has created a new List:
 *
 *  - Client creates List ID (length 22)
 *  - Client sends create event to endpoint when possible (could be offline)
 *  - Server takes List ID and amends it to make it +1 in length, as well as
 *    ensure uniqueness
 *  - Server responds to update Client with extended ID
 *      - maybe with a status 304 to forward the page to the ID?
 *      - can Replicache handle this? It might jsut work?
 *
 * After looking into Replicache, I don't know how to update the client
 * Replicache store `name` to make it the full-length ID... so we're
 * gonna leave things there for now. Revisit this if needed.
 */
