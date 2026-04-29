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
import { EntityRow, GetEntity } from './entity';
import { initListArgsSchema } from './mutators/client';

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

type EntityType = 'list' | 'template';

/**
 * D1 is authoritative for entity-level metadata per ADR 0001. The DO's
 * stored list element carries placeholders for these fields; the worker
 * overlays the real values from the D1 entity row before returning to
 * clients. This is the single composition seam for entity metadata.
 */
function overlayEntityFields<T extends Record<string, unknown>>(
    listElement: T,
    entity: EntityRow,
): T {
    return {
        ...listElement,
        authorization_rules: entity.authorization_rules,
        workspace_id: entity.workspace_id,
        forked_from_id: entity.forked_from_id,
    };
}

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
 * (List or Template). Both share the same DO machinery and Replicache
 * sync — the differences are: which ID prefix is the default for
 * unprefixed query params, which prefix is required, and which value
 * gets written into `workspace_entities.type` on init reconciliation.
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
        return c.json(overlayEntityFields(list, entity));
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

        const entity = c.get('entity')!;
        const patch = pullResponse.patch.map(op =>
            op.op === 'put' && op.key === entity.id
                ? {
                      ...op,
                      value: overlayEntityFields(
                          op.value as Record<string, unknown>,
                          entity,
                      ),
                  }
                : op,
        );
        return c.json({ ...pullResponse, patch });
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
        if (!c.get('entity')) throw new NotFoundError();

        const requestRole = c.get('authorized_role');
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
