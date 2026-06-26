import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PushRequestV1 } from 'replicache';

import type { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import {
    credentialPermitsEntity,
    RevokeEntityBoundCredential,
} from '../auth/credential';
import {
    ListConnectedClients,
    ResolveAccountDisplays,
    ResolveCredentialLabels,
    partitionConnectedClients,
} from '../auth/connected';
import {
    type AuthorizationRole,
    AuthorizationRoleEnum,
    type AuthorizationRules,
} from '@djibb/protocol/auth/rules';

import {
    BadRequestError,
    DjibbError,
    NotFoundError,
    ParseError,
    UnexpectedError,
    ValidationError,
} from '@djibb/protocol/errors';
import { UnauthorizedError } from '../auth/errors';
import { ReplicachePullRequestSchema } from '../replicache';
import { z } from 'zod';
import { IdTypes } from '@djibb/protocol/id';
import { GetMembership } from '../workspace/service';
import { canRead, resolveRole } from '../auth/resolver';
import { GetEntity } from './entity';
import { asLocalList } from './durable_object';
import { initListArgsSchema, mintFromBlankArgsSchema } from '@djibb/protocol/list/mutators/client';
import { OWNER_ROLES } from '@djibb/protocol/list/mutators/_shared';

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

    // Bound-credential enforcement (ADR 0022 §Negative, GH #20). The
    // request→Account seam carries `bound_entity_id` forward without
    // enforcing it (the entity isn't in scope there); this is where the
    // target entity IS known, so it's the one place the binding can be
    // applied. A bound token used on any entity but its own is rejected,
    // before role resolution and uniformly across every route (GET, /audit,
    // /pull, /push). Unbound and cookie/anonymous requests pass through.
    app.use('*', async (c, next) => {
        if (!credentialPermitsEntity(c.get('credential'), c.get('entity_id'))) {
            throw new UnauthorizedError(
                'credential is bound to a different entity',
            );
        }
        await next();
    });

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

        // View-floor (ADR 0021 / issue #13): this route returns the
        // entity row (name, rules, description) — content below the read
        // floor. A below-floor role (`restricted` / `submitter`) gets a
        // 404 rather than leaking existence/metadata, consistent with the
        // empty content patch `handlePull` returns over `/pull`.
        if (!canRead(c.get('authorized_role'))) throw new NotFoundError();

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

    /**
     * Owner-gated audit log for this entity (workspace Phase 5 polish).
     * Reads the DO's append-only `mutations` table newest-first. The log
     * can expose PII in mutation args (e.g. invited emails), so it is
     * restricted to `OWNER_ROLES` — `restricted`/`member` callers get a
     * 403 even though they can read the entity itself.
     *
     * Query params: `limit` (1–200, default 50) and `before` (the `seq`
     * of the last row from the previous page, for "load older").
     * Response: `{ entries, nextBefore }` where `nextBefore` is the seq
     * to pass as `before` for the next page, or `null` at the end.
     */
    app.get('/audit', async c => {
        const entity = c.get('entity');
        if (!entity) throw new NotFoundError();

        if (!OWNER_ROLES.includes(c.get('authorized_role'))) {
            throw new UnauthorizedError(
                'audit log is restricted to owners and admins',
            );
        }

        const limitParam = Number(c.req.query('limit'));
        const limit = Number.isFinite(limitParam) ? limitParam : 50;
        const beforeParam = c.req.query('before');
        const before =
            beforeParam == null || beforeParam === ''
                ? null
                : Number(beforeParam);

        const result = await c.get('list').getMutationLog({ limit, before });
        if (result.error) {
            return new Response(
                JSON.stringify({
                    code: result.error.code,
                    error: result.error.name,
                    message: result.error.message,
                }),
                {
                    headers: { 'Content-Type': 'application/json' },
                    status: result.error.httpStatusCode,
                },
            );
        }
        // `?? []` only fires in the (already-returned) error case; the
        // RPC boundary widens the Result union so TS can't see that.
        const entries = result.data ?? [];

        // A full page implies there may be more; the last entry's seq is
        // the cursor for the next "load older" request.
        const clampedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
        const nextBefore =
            entries.length === clampedLimit
                ? entries[entries.length - 1]!.seq
                : null;

        // Attribution (§5, #24): resolve the acting credential_id of each
        // entry to its label so the client can render "via <label>". One
        // batched lookup over the page's distinct credential ids.
        const credentialIds = entries
            .map(e => e.credential_id)
            .filter((id): id is string => id != null);
        const labelMap = await ResolveCredentialLabels(
            c.env.DJIBB_AUTH,
            credentialIds,
        );
        const credentialLabels = Object.fromEntries(labelMap);

        return c.json({ entries, nextBefore, credentialLabels });
    });

    /**
     * The connected-clients access surface (ADR 0022 §6, GH #24). Manager-
     * gated, like /audit. Returns the unioned view of everything connected
     * to this entity — every member Account (from the authorization roster)
     * with its interactive sessions and issued tokens (#23's union read) —
     * plus the Account display fields so the surface renders names not ids.
     *
     * Scope is the entity's authorized Accounts; `entityId` narrows tokens
     * to unbound + bound-here. The client groups by account and splits the
     * active roster from history by `state`. We pre-split here too so the
     * shape mirrors the prototype's two sections.
     */
    app.get('/connected', async c => {
        const entity = c.get('entity');
        if (!entity) throw new NotFoundError();

        if (!OWNER_ROLES.includes(c.get('authorized_role'))) {
            throw new UnauthorizedError(
                'connected clients are restricted to owners and admins',
            );
        }

        const memberAccountIds = Object.keys(
            entity.authorization_rules.authorized_accounts,
        );
        const entityId = c.get('entity_id');

        const [clients, displays] = await Promise.all([
            ListConnectedClients(c.env.DJIBB_AUTH, {
                accountIds: memberAccountIds,
                entityId,
            }),
            ResolveAccountDisplays(c.env.DJIBB_AUTH, memberAccountIds),
        ]);

        const { active, history } = partitionConnectedClients(clients);
        const accounts = memberAccountIds.map(id => ({
            account_id: id,
            role:
                entity.authorization_rules.authorized_accounts[id]?.role ??
                'viewer',
            display_name: displays.get(id)?.display_name ?? null,
            email: displays.get(id)?.email ?? null,
        }));

        return c.json({ accounts, active, history });
    });

    /**
     * Manager-revoke for the connected-clients surface (#24). Revokes a
     * single token **only if it is bound to this entity** — the structural
     * guarantee that a workspace manager severs access to *this entity*,
     * never to an Account (the locked-in scope rule). Account-wide sessions
     * and unbound tokens never match `RevokeEntityBoundCredential`'s
     * `bound_entity_id = ?` predicate, so this path cannot reach them; the
     * owner manages those via self-service (a separate surface). Removing a
     * member or bot's entity access is the existing `removeMember` mutator,
     * not this route.
     */
    app.post('/connected/revoke', async c => {
        const entity = c.get('entity');
        if (!entity) throw new NotFoundError();

        if (!OWNER_ROLES.includes(c.get('authorized_role'))) {
            throw new UnauthorizedError(
                'revoking connected clients is restricted to owners and admins',
            );
        }

        const body = await c.req.json().catch(() => {
            throw new ParseError();
        });
        const credentialId = body?.credentialId;
        if (typeof credentialId !== 'string' || !credentialId) {
            throw new ValidationError('credentialId is required');
        }

        const revoked = await RevokeEntityBoundCredential(c.env.DJIBB_AUTH, {
            credentialId,
            entityId: c.get('entity_id'),
        });
        if (!revoked) {
            // No live token bound to this entity matched. Either it isn't
            // bound here (an account-wide / other-entity token a manager may
            // not touch), already revoked, or unknown — all indistinguishable
            // to a manager and all "nothing to do here."
            throw new UnauthorizedError(
                'no revocable entity-bound token matched',
            );
        }

        return c.json({ revoked: true });
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

        const { data: pullResponse, error } = await asLocalList(
            c.get('list')
        ).handlePull({
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
            // Entity-creating mutators: the only mutations allowed to
            // arrive for an id that doesn't exist yet. `initList` writes a
            // shell (optionally with content); `mintFromBlank` forks a
            // Blank Template into a brand-new List (homepage mint-on-engage,
            // Phase 4a). Both carry the same envelope fields the ownership
            // checks below read (`listId`/`accountId`/`workspaceId`), so the
            // only per-mutator difference is which schema validates the args.
            // mintFromBlank's content fidelity is verified separately by the
            // DO preflight (`_handlePush`, ADR fork verify) — not here.
            const first = pushRequest.mutations[0];
            const initArgs = (() => {
                if (first?.name === 'initList') {
                    const p = initListArgsSchema.safeParse(first.args);
                    if (!p.success) {
                        throw new ValidationError('invalid initList args');
                    }
                    return p.data;
                }
                if (first?.name === 'mintFromBlank') {
                    const p = mintFromBlankArgsSchema.safeParse(first.args);
                    if (!p.success) {
                        throw new ValidationError('invalid mintFromBlank args');
                    }
                    return p.data;
                }
                throw new NotFoundError();
            })();

            if (initArgs.listId !== c.get('entity_id')) {
                throw new ValidationError(
                    'init args.listId does not match request entity id',
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
        // ADR 0011 §Step 10a.3: `'system'` is structurally unreachable
        // from any session-driven resolver path today (it's excluded
        // from `AccountRoleEnum`, `DefaultRoleEnum`, and the explicit-
        // grant schema), so this branch should be dead. Kept as a
        // belt-and-suspenders gate: if a future resolver change ever
        // produced `'system'` from session state, the HTTP boundary
        // would refuse to forward it, preserving the invariant that
        // cascade and other system-only mutations can only originate
        // from DO-stub-to-DO-stub RPC.
        if (requestRole === 'system') {
            console.error(
                '/push refused: resolver produced `system` role from HTTP path'
            );
            throw new UnauthorizedError();
        }

        const listId = c.get('list').name ?? c.get('entity_id');
        if (!listId) throw new UnexpectedError('invalid listId');

        const { error } = await c.get('list').handlePush({
            authorizedAccounts: c.get('session')?.accounts || [],
            authorizedRole: c.get('authorized_role'),
            listId,
            pushRequest,
            // Acting credential (ADR 0022 §5) — server-resolved at the
            // request→Account seam; null for cookie sessions / anonymous.
            actingCredentialId: c.get('credential')?.credential_id ?? null,
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
