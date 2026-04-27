import { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PushRequestV1 } from 'replicache';

import { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import { AuthorizationRole, AuthorizationRoleEnum } from '../auth/rules';

import {
    DjibbError,
    NotFoundError,
    ParseError,
    UnexpectedError,
    ValidationError,
} from '../errors';
import { UnauthorizedError } from '../auth/errors';
import { ReplicachePullRequestSchema } from '../replicache';
import { z } from 'zod';
import { tryCatch } from '../utils/trycatch';
import { IdTypes } from '../id';
import { GetMembership } from '../workspace/service';
import { resolveRole } from '../auth/resolver';
import { GetEntity, InsertEntityIfMissing } from './entity';
import { initListArgsSchema } from './mutators/client';
import {
    AuthorizationRulesSchema,
    AuthorizationRules,
} from '../auth/rules';

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

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
    // Accept `?id=` (canonical) or `?l=` (legacy alias).
    const query_param_id = c.req.query('id') ?? c.req.query('l');

    if (!query_param_id) {
        throw new HTTPException(400, {
            message:
                'missing `id` search query parameter to identify requested entity',
        });
    }

    const hasPrefix = /^[a-z]+\//.test(query_param_id);
    let prefixedId = hasPrefix
        ? query_param_id
        : `${IdTypes['list']}/${query_param_id}`;

    c.set('entity_id', prefixedId);

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
/**
 * Resolves a role from the session against given rules + the calling
 * account's workspace membership. Cross-account picking (explicit >
 * workspace > default; active-account tiebreaker) lives here because it
 * is orthogonal to per-account role resolution.
 */
async function resolveSessionRole(
    c: Context<HonoEnv>,
    rules: AuthorizationRules,
    workspaceId: string | null,
): Promise<AuthorizationRole> {
    const session = c.get('session');
    const sessionAccounts = session?.accounts ?? [];

    const activeAccountHeader = c.req.header(ACTIVE_ACCOUNT_HEADER) || null;
    const activeAccountId = activeAccountHeader
        ? sessionAccounts.find(a => a.id === activeAccountHeader)?.id ?? null
        : null;

    type Candidate = {
        accountId: string;
        role: AuthorizationRole;
        source: 'explicit' | 'workspace' | 'default';
    };
    const candidates: Candidate[] = [];

    for (const account of sessionAccounts) {
        const hasExplicit =
            rules.authorized_accounts[account.id] != null;
        let workspaceRole = null;
        if (!hasExplicit && workspaceId) {
            const membership = await GetMembership(
                c.env.DJIBB_AUTH,
                account.id,
                workspaceId,
            );
            workspaceRole = membership?.role ?? null;
        }
        candidates.push({
            accountId: account.id,
            role: resolveRole(
                { account_id: account.id },
                rules,
                workspaceRole,
            ),
            source: hasExplicit
                ? 'explicit'
                : workspaceRole
                ? 'workspace'
                : 'default',
        });
    }

    function pickByActive(level: Candidate[]): Candidate {
        return (
            (activeAccountId
                ? level.find(c => c.accountId === activeAccountId)
                : undefined) ?? level[0]!
        );
    }

    const explicit = candidates.filter(c => c.source === 'explicit');
    const workspace = candidates.filter(c => c.source === 'workspace');
    if (explicit.length) return pickByActive(explicit).role;
    if (workspace.length) return pickByActive(workspace).role;
    return resolveRole(null, rules, null);
}

list_app.use(async (c, next) => {
    // Read entity metadata from D1 (authoritative per ADR 0001).
    // Missing → pre-init: defer auth to /push, which will reconcile by
    // inserting the canonical row before forwarding to the DO.
    const entity = await GetEntity(c.env.DJIBB_AUTH, c.get('entity_id'));
    c.set('entity', entity);

    if (!entity) {
        await next();
        return;
    }

    const authRole = await resolveSessionRole(
        c,
        entity.authorization_rules,
        entity.workspace_id,
    );
    c.set('authorized_role', authRole);

    await next();
});

// idk, i'd prefer this to be `/list/my-list-id` than `/list?l=my-list-id` but here we are
// would need to change middleware probably
list_app.get('', async c => {
    if (!c.get('entity')) throw new NotFoundError();

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
    if (!c.get('entity')) throw new NotFoundError();

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
    const listId = c.get('list').name ?? c.get('entity_id');
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

    // Pre-init reconciliation: if no D1 row exists for this entity yet,
    // the first push must begin with an `initList` mutation. The worker
    // inserts the canonical row in D1, then re-resolves the role and
    // forwards the push to the DO. ADR 0001 §Reconciliation protocol.
    if (!c.get('entity')) {
        const first = pushRequest.mutations[0];
        if (!first || first.name !== 'initList') {
            throw new NotFoundError();
        }
        const argsParse = initListArgsSchema.safeParse(first.args);
        if (!argsParse.success) {
            throw new ValidationError('invalid initList args');
        }
        const initArgs = argsParse.data;

        if (initArgs.listId !== c.get('entity_id')) {
            throw new ValidationError(
                'initList args.listId does not match request entity id',
            );
        }

        // Init authorization: an authenticated init must claim an
        // account from the current session. A workspace-targeted init
        // requires membership.
        const sessionAccounts = c.get('session')?.accounts ?? [];
        if (initArgs.accountId) {
            const ownsAccount = sessionAccounts.some(
                a => a.id === initArgs.accountId,
            );
            if (!ownsAccount) throw new UnauthorizedError();
        }
        if (initArgs.workspaceId) {
            if (!initArgs.accountId) throw new UnauthorizedError();
            const membership = await GetMembership(
                c.env.DJIBB_AUTH,
                initArgs.accountId,
                initArgs.workspaceId,
            );
            if (!membership) throw new UnauthorizedError();
        }

        const initRules: AuthorizationRules = initArgs.accountId
            ? {
                  authorized_accounts: {
                      [initArgs.accountId]: { role: 'owner' },
                  },
                  default_role: 'restricted',
                  set_by: 'user',
              }
            : {
                  authorized_accounts: {},
                  default_role: 'ownerless',
                  set_by: 'defaults',
              };

        const inserted = await InsertEntityIfMissing(c.env.DJIBB_AUTH, {
            id: initArgs.listId,
            workspace_id: initArgs.workspaceId,
            type: 'list',
            authorization_rules: initRules,
            time_created: Math.floor(
                initArgs.timestamp_client.getTime() / 1000,
            ),
        });

        c.set('entity', inserted);
        c.set(
            'authorized_role',
            await resolveSessionRole(
                c,
                inserted.authorization_rules,
                inserted.workspace_id,
            ),
        );
    }

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
    const listId = c.get('list').name ?? c.get('entity_id');
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
    if (!c.get('entity')) throw new NotFoundError();

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
