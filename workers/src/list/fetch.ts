import { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PushRequestV1 } from 'replicache';

import { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import {
    AuthorizationRole,
    AuthorizationRoleEnum,
    AuthorizationRules,
} from '../auth/rules';

import {
    BadRequestError,
    DjibbError,
    NotFoundError,
    ParseError,
    UnexpectedError,
    ValidationError,
} from '../errors';
import { UnauthorizedError } from '../auth/errors';
import { ReplicachePullRequestSchema } from '../replicache';
import { z } from 'zod';
import { IdTypes } from '../id';
import { GetMembership } from '../workspace/service';
import { resolveRole } from '../auth/resolver';
import { GetEntity } from './entity';
import { initListArgsSchema } from './mutators/client';

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

type EntityType = 'list' | 'template' | 'workspace';

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

/**
 * Builds the sub-router that handles a single top-level entity type
 * (List, Template, or Workspace — see ADR 0011). They share the same
 * DO machinery and Replicache sync — the only per-type differences are
 * the ID prefix that's the default for unprefixed query params, the
 * prefix that's required, and the value written into
 * `workspace_entities.type` on init reconciliation.
 */
export function makeEntityRouter(entityType: EntityType): Hono<HonoEnv> {
    const idPrefix = IdTypes[entityType];
    const app = new Hono<HonoEnv>();

    /**
     * Resolves the entity ID, attaches the DO stub, and rejects if the
     * caller's ID prefix doesn't match this router's entity type.
     */
    app.use('*', async (c, next) => {
        const query_param_id = c.req.query('id') ?? c.req.query('l');
        if (!query_param_id) {
            throw new BadRequestError(
                'missing `id` search query parameter to identify requested entity',
            );
        }

        const hasPrefix = /^[a-z]+\//.test(query_param_id);
        const prefixedId = hasPrefix
            ? query_param_id
            : `${idPrefix}/${query_param_id}`;

        if (!prefixedId.startsWith(`${idPrefix}/`)) {
            throw new BadRequestError(
                `entity id prefix does not match endpoint type "${entityType}"`,
            );
        }

        c.set('entity_id', prefixedId);

        const durable_object_id: DurableObjectId =
            c.env.DJIBB_LIST.idFromName(prefixedId);
        c.set('id', durable_object_id);

        const stub = c.env.DJIBB_LIST.get(durable_object_id);
        if (!stub) {
            console.error('no DJIBB_LIST stub!');
            throw new UnexpectedError();
        }
        c.set('list', stub);

        await next();
    });

    app.use('*', HandleSession);

    app.use(async (c, next) => {
        // Read entity metadata from D1 (authoritative per ADR 0001).
        // Missing → pre-init: defer auth to /push, which will reconcile
        // by inserting the canonical row before forwarding to the DO.
        const entity = await GetEntity(c.env.DJIBB_AUTH, c.get('entity_id'));
        c.set('entity', entity);

        if (!entity) {
            await next();
            return;
        }

        if (entity.type !== entityType) {
            // ID prefix matched the endpoint type but the stored row
            // disagrees. Treat as not-found rather than leak existence.
            c.set('entity', null);
            await next();
            return;
        }

        c.set(
            'authorized_role',
            await resolveSessionRole(
                c,
                entity.authorization_rules,
                entity.workspace_id,
            ),
        );

        await next();
    });

    app.get('', async c => {
        const entity = c.get('entity');
        if (!entity) throw new NotFoundError();

        const listId = c.get('list').name ?? c.get('entity_id');
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
                },
            );
        }
        return c.json(list);
    });

    app.post('/pull', async c => {
        if (!c.get('entity')) throw new NotFoundError();

        const json = await c.req.json().catch(() => {
            throw new ParseError();
        });
        const parse_result = ReplicachePullRequestSchema.safeParse(json);
        if (!parse_result.success) {
            console.log(
                'invalid PullRequest body:',
                z.formatError(parse_result.error),
            );
            throw new ValidationError('invalid JSON value(s)');
        }

        const listId = c.get('list').name ?? c.get('entity_id');
        if (!listId) throw new UnexpectedError('invalid listId');

        const { data: pullResponse, error } = await c.get('list').handlePull({
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
                },
            );
        }

        return c.json({ ...pullResponse });
    });

    app.post('/push', async c => {
        const pushRequest = (await c.req.json().catch(() => {
            throw new ValidationError();
        })) as PushRequestV1;

        // Pre-init authorization: per ADR 0003 the DO is the single
        // writer for entity metadata, so the worker no longer touches
        // D1 here. It still validates session ownership of the claimed
        // account and workspace membership before letting the push
        // through, and computes the request's role locally so the DO
        // call carries the right authorization context. The DO writes
        // its state and emits a snapshot to D1 post-commit.
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

            // Init has no prior rules to consult: the caller is the
            // owner-to-be (if authed) or an anonymous editor of an
            // ownerless list. Skip the rules round-trip; assign the
            // role directly.
            c.set(
                'authorized_role',
                initArgs.accountId ? 'owner' : 'ownerless',
            );
        }

        // ADR 0009 Slice 3 redo: there is intentionally no HTTP-layer
        // role gate or invitation preflight here. The DO is the
        // security boundary — each mutator declares `requiredRole`,
        // and invitation-family mutators run an async preflight inside
        // `_handlePush` (with D1 access) before the synchronous mutator
        // fires. Failures surface as skip-and-ack outcomes on the WS
        // outcome channel rather than as HTTP 4xx, which keeps
        // Replicache from wedging its retry loop on permanent failures
        // (no client-side API drops a pending mutation).
        //
        // The one thing the HTTP layer still validates is that the
        // resolved role parses cleanly. An unparseable role here
        // means the auth resolver returned something unexpected — that
        // IS an exceptional state worth bailing on.
        const requestRole = c.get('authorized_role');
        if (!AuthorizationRoleEnum.safeParse(requestRole).success) {
            console.log('/push throw unauth — bad role!');
            throw new UnauthorizedError();
        }

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
                },
            );
        }
        return new Response(null, { status: 200 });
    });

    app.get('/websocket', async c => {
        // Pre-init: the page-side share/list routes mount Replicache and
        // open the websocket in the same effect. On a fresh ID the WS
        // upgrade races the initList push that creates the D1 row, so
        // `entity` is briefly null. Mirror /push's pre-init posture
        // (line ~263): allow the upgrade and forward to the DO. The DO
        // is the source of truth for connection state; mutations still
        // go through /push which has its own auth. Once initList lands,
        // pokes flow normally over the existing connection.
        //
        // No role gate here. Aligns with `_handlePull`'s permissive
        // posture (see durable_object.ts) — restricted-role invitees
        // need the connection to receive the post-accept poke that
        // triggers their next pull. Pokes themselves are non-sensitive
        // (they just say "something changed"); per-mutation outcome
        // messages are unicast to the originating clientID, so a
        // restricted user can't observe other clients' outcomes.

        // Use `fetch` for WebSocket because we're returning a Response
        // that isn't serializable.
        return c.get('list').fetch(c.req.raw);
    });

    app.onError(err => {
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
                },
            );
        } else if (err instanceof HTTPException) {
            throw err;
        }

        console.error('entity router unhandled err:', err);
        return new Response(null, {
            status: 500,
            statusText: 'Internal Server Error',
        });
    });

    return app;
}

export const list_app = makeEntityRouter('list');
export const template_app = makeEntityRouter('template');
export const workspace_app = makeEntityRouter('workspace');
