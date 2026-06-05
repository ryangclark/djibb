import { DurableObject } from 'cloudflare:workers';
import { MutationV1, PullResponseOKV1, PushRequestV1 } from 'replicache';

import { ReplicachePullRequest } from '../replicache';
import { isEntityRow, isEntityRowType, List, ListElement } from './index';
import {
    executeServerMutation,
    MutationStatus,
    parseMutationEnvelope,
} from './mutators';
import { OWNER_ROLES } from './mutators/_shared';

import { AuthorizationRole } from '../auth/rules';
import {
    encodeWSMessage,
    WS_QUERY_CLIENT_ID,
    WS_STATE,
    type MutationOutcomeStatus,
    type WSMessage,
} from '../websocket/constants';
import { Bindings } from '..';
import {
    BadMutationError,
    DjibbError,
    NotFoundError,
    SerializedDjibbError,
    TablesAlreadyInitializedError,
    UnauthorizedError,
    UnexpectedError,
} from '../errors';
import {
    getChangedElements,
    getElementById,
    getEntityId,
    getListVersion,
    getReplicacheClientGroupById,
    InitializeTables,
    setListVersion,
    setMutation,
    setReplicacheClientGroup,
} from './sql';
import { Account } from '../account';
import { Result, tryCatch, tryCatchAsync } from '../utils/trycatch';
import {
    EmitEntityMembershipsToCatalog,
    EmitEntitySnapshotToCatalog,
    GetEntityVersion,
} from './entity';
import {
    CountInvitesByInviterSince,
    CountOutstandingInvitesByInviter,
    EmitInvitationsSnapshot,
    GetInvitationFromIndex,
    InvitationIdentityKindEnum,
    MarkInvitationsAccepted,
    ensurePendingInvitesTable,
    listPendingInvites,
    normalizeIdentityValue,
    preflightAcceptInvitation,
    preflightInviteByIdentity,
    type AcceptPreflightFailureReason,
    type InvitationIdentityKind,
    type InvitePreflightFailureReason,
} from './invitations';
import { tryClaimSlug } from './slug';
import { GetAccountByEmail } from '../account/service';
import { sendEntityInvitationEmail } from '../email';
import { LIST_PULL_KEYSPACES } from './pull';
import {
    appendKeyspacePatches,
    encodePullCookie,
    parsePullCookie,
} from '../replicache/keyspaces';
import { newId } from '../id';

/**
 * Mutator names that change entity-level metadata (the fields projected
 * to the D1 read index). Used by the push handler to decide whether to
 * emit an entity snapshot post-commit. Add entries here as new metadata
 * mutators land (renameList, setListAuthRules, archiveList, ...).
 */
const ENTITY_METADATA_MUTATORS: ReadonlySet<string> = new Set([
    'acceptInvitation',
    'archiveList',
    'cascadeArchiveList',
    'cascadeRestoreList',
    'changeMemberRole',
    'createWorkspace',
    'initFromTemplate',
    'initList',
    'leaveMember',
    'removeMember',
    'renameList',
    'renameWorkspace',
    'setDescription',
    'setListAuthRules',
    'setWorkspaceImage',
    'setWorkspaceSlug',
    'transferOwnership',
    'unarchiveList',
]);

/**
 * Mutator names that touch the DO's `pending_invites` table. Used by
 * the push handler to decide whether to reconcile invitations to the
 * D1 read index post-commit (ADR 0009). The reconciler runs once per
 * push regardless of how many invitation mutations were in the batch
 * — it's a full-snapshot diff, not per-row.
 */
const INVITATION_MUTATORS: ReadonlySet<string> = new Set([
    'acceptInvitation',
    'inviteByIdentity',
    'revokeInvitation',
]);

/**
 * Mutators whose push-time semantics depend on cross-target / cross-
 * entity state and need an async preflight before `handleMutation`
 * (ADR 0009 Slice 3). The preflight has D1 access; the synchronous
 * mutator does not. Failures from this preflight become structured
 * skip-and-ack outcomes rather than throws (see `_handlePush`).
 */
const PREFLIGHTED_MUTATORS: ReadonlySet<string> = new Set([
    'acceptInvitation',
    'inviteByIdentity',
    'setWorkspaceSlug',
]);

/**
 * Map a `setWorkspaceSlug` preflight failure code to the wire-level
 * `MutationOutcomeStatus`. Slug claim failures are all preconditions
 * from the client's perspective — the request was well-formed and
 * the caller was authorized, the state of the world just doesn't
 * allow it (slug taken / reserved / invalid / target gone).
 */
function slugReasonToOutcomeStatus(
    reason: import('./slug').SlugClaimFailureReason,
): MutationOutcomeStatus {
    switch (reason) {
        case 'entity_missing':
            return 'gone';
        case 'slug_invalid':
        case 'slug_reserved':
        case 'slug_taken':
            return 'precondition';
    }
}

/**
 * Map an `inviteByIdentity` preflight failure code to the wire-level
 * `MutationOutcomeStatus`. The reason string still flows verbatim
 * (alongside `message`) so the client can branch on the specific
 * cause; this mapping is purely the category bucket for clients that
 * only know the legacy outcome enum.
 */
function inviteReasonToOutcomeStatus(
    reason: InvitePreflightFailureReason
): MutationOutcomeStatus {
    switch (reason) {
        case 'unauthenticated_inviter':
        case 'session_mismatch':
            return 'auth';
        case 'entity_missing':
            return 'gone';
        case 'rate_limit_hour':
        case 'outstanding_cap':
        case 'already_member':
        case 'self_invite':
            return 'precondition';
    }
}

function acceptReasonToOutcomeStatus(
    reason: AcceptPreflightFailureReason
): MutationOutcomeStatus {
    switch (reason) {
        case 'unauthenticated_acceptor':
        case 'session_mismatch':
        case 'identity_unverified':
            return 'auth';
        case 'invitation_not_found':
            return 'gone';
        case 'invitation_not_pending':
        case 'invitation_expired':
            return 'precondition';
    }
}

/**
 * Multi-event alarm dispatcher event names (ADR 0011 §Step 10a.2 /
 * ADR 0008). One per kind of scheduled work the DO does:
 *
 *   - reconcile        : ADR 0007 D1 drift check (every DO, every day)
 *   - cascade-archive  : Workspace DO sweeps children on
 *                        `softDeleteWorkspace` (10a.4)
 *   - cascade-restore  : Workspace DO sweeps children on
 *                        `restoreWorkspace` (10a.5)
 *   - harddelete       : per-DO self-destruct 30d after soft delete
 *                        (10a.6 / 10b)
 *
 * Adding a new event: extend this union, register a case in
 * `runAlarmEvent`, schedule via `scheduleEvent(name, dueAt)`.
 */
export type AlarmEventName =
    | 'reconcile'
    | 'cascade-archive'
    | 'cascade-restore'
    | 'harddelete';

/**
 * TODO:
 * [] update to SQL - Look for `this.ctx.storage.get` and similar method calls.
 * [] top-level handlers should not throw
 */

export class DjibbList extends DurableObject {
    id: DurableObjectId;
    sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Bindings) {
        super(ctx, env);

        this.sql = ctx.storage.sql;

        // env.DJIBB_AUTH.prepare

        this.id = ctx.id;
        // console.log(this.id); // cd62f1a5a8e61d6c7594a12bfcbdbc77ad6dae0a73ca3b5f22bdb4e14c9879cf

        // Can we pull the ID from the request?
        // You literally can't get it from ctx.id.name within the DO, it's on their roadmap to implement...
        // Throw an error if the initialize request doesn't have an ID we can reliably get...
        // this

        // if (!this.id.name) {
        //     throw new UnexpectedError('invalid `ctx.id.name`!');
        // }

        // `blockConcurrencyWhile()` ensures no requests are delivered until
        // initialization completes.
        // We need the tables initialized to handle core operations.
        ctx.blockConcurrencyWhile(() => {
            console.log('BEGIN BLOCK_CONCURRENCY_WHILE_INITIALIZE_TABLES');
            try {
                InitializeTables(this.sql);
            } catch (error) {
                if (error instanceof TablesAlreadyInitializedError) {
                    // Expected error if we're already initialized.
                } else {
                    console.error(
                        'Unexpected error initializing tables:',
                        error
                    );

                    // Throwing is severe in a Durable Object, requiring
                    // a Worker to recreate the DO stub to use it again.
                    //
                    // But, I guess you do need to throw here.
                    throw error;
                }
            }

            // Forward-migration for ADR 0009: ensure the
            // `pending_invites` table exists on every constructor pass.
            // `IF NOT EXISTS` makes this safe for fresh DOs (where
            // `InitializeTables` just ran) and DOs that came up before
            // ADR 0009 landed (where the table was never created).
            try {
                ensurePendingInvitesTable(this.sql);
            } catch (error) {
                console.error(
                    'Unexpected error ensuring pending_invites table:',
                    error
                );
                throw error;
            }

            console.log('END BLOCK_CONCURRENCY_WHILE_INITIALIZE_TABLES');

            return Promise.resolve();
        });
    }

    getList(args: { listId: string }): Result<List, SerializedDjibbError> {
        return tryCatch(() => this._getList(args));
    }

    _getList({ listId }: { listId: string }) {
        const list = getElementById(this.sql, listId);

        // Same DO machinery serves every entity-row type (list,
        // template, workspace — see ADR 0011); accept any of them.
        if (!list || !isEntityRow(list)) {
            console.log('bad entity:', list);

            throw new NotFoundError(`entity not found: ${listId}`);
        }

        return list;
    }

    /**
     * Handles Pull requests by evaluating where the requesting client
     * stands (what data does it have?), and creating a patch of changes
     * to get it up to date with the Server's state.
     */
    public handlePull(args: {
        authorizedRole: AuthorizationRole;
        listId: string;
        pullRequest: ReplicachePullRequest;
    }): Result<PullResponseOKV1, SerializedDjibbError> {
        return tryCatch(() => this._handlePull(args));
    }

    private _handlePull({
        authorizedRole,
        listId,
        pullRequest,
    }: {
        authorizedRole: AuthorizationRole;
        listId: string;
        pullRequest: ReplicachePullRequest;
    }): PullResponseOKV1 {
        // Allow restricted-role pulls. ADR 0009 invitees arrive at
        // `/l/<id>?from_invite=1` with `restricted` role (until they
        // click Accept and the server promotes them). Blocking pull
        // here means their Replicache client retry-storms 403s while
        // the InviteBanner is on screen, hogging network events and
        // confusing the page lifecycle. Reads are cheap; per-mutator
        // `requiredRole` gates remain the authoritative write gate.
        // The role-gated keyspaces (`pending_invites/*`, etc.) below
        // still filter what restricted users see.
        //
        // @TODO: tighten read access if/when ADR 0009 grows a
        //   "preview the invite without granting full read" tier —
        //   for now invitees can only get here via a tokenless URL
        //   built into their invitation email, so any entity they
        //   reach this code path with is one they were invited to.

        // Cookie shape is `{v, r}` (entity version + the role this
        // client last pulled as). `null` is the canonical fresh-pull
        // form. Role transitions (promotion / demotion) are detected
        // by comparing `previousRole` against the request's current
        // `authorizedRole` to decide per-keyspace patches (ADR 0009).
        const parsedCookie = parsePullCookie(pullRequest.cookie);
        const requestVersion = parsedCookie.v;
        const previousRole = parsedCookie.r;

        let listElements: Array<ListElement>;

        // Track the resolved entity version in a local; emit the
        // role-versioned cookie shape once at the end via
        // `encodePullCookie`. `-1` is the legacy bad-version sentinel;
        // kept as the starting value so an early-return through one
        // of the catch-and-return branches surfaces unchanged.
        let resolvedEntityVersion = -1;

        // Init our response with default property values. The cookie
        // is set to the role-versioned shape just before return; -1
        // here mirrors the legacy bad-version sentinel.
        const pullResponse: PullResponseOKV1 = {
            cookie: -1,
            lastMutationIDChanges: {},
            patch: [],
        };

        try {
            listElements = getChangedElements(this.sql, requestVersion);
        } catch (error) {
            if (
                error
                    ?.toString()
                    .startsWith('Error: no such table: list_elements')
            ) {
                return pullResponse;
            }

            console.error('`getChangedElements()` error:', error);

            throw new UnexpectedError();
        }

        // Look up the Client Group for the request's `clientGroupID` value.
        // Then, loop through the Group's Clients to pull the
        // `lastMutationID` for each.
        // Replicache needs that info to confirm which mutations have
        // been canonicalized on the server.
        let replicacheClientGroup = getReplicacheClientGroupById(
            this.sql,
            pullRequest.clientGroupID
        );

        if (!replicacheClientGroup) {
            console.log(
                `\`handlePull()\` ReplicacheClientGroup not found for ID "${pullRequest.clientGroupID}"`
            );

            replicacheClientGroup = {
                accountId: null, // TODO: do we have an account ID?
                clients: [],
                id: pullRequest.clientGroupID,
            };
        }

        // Loop through the Clients in the ClientGroup. If a client's
        // `lastModifiedVersion` is greater than the `requestVersion`,
        // then we'll include that Client's last Mutation ID in the
        // Pull Response. That allows Replicache to know where that
        // client stands in comparison to the Server's authoritative
        // state.
        for (const client of replicacheClientGroup.clients) {
            if (client.lastModifiedVersion > requestVersion) {
                pullResponse.lastMutationIDChanges[client.id] =
                    client.lastMutationId;
            }
        }

        // Set the response's `cookie` value, which is the List's version.
        // Find the Version by looping through the List Elements, looking
        // for the List Itself. If not among the updated element, pull
        // the list directly.
        let foundListVersion = false;
        if (listElements.length > 0) {
            for (const element of listElements) {
                if (isEntityRowType(element.type)) {
                    foundListVersion = true;
                    resolvedEntityVersion = element.version;
                    break;
                }
            }
        }

        if (!foundListVersion) {
            // Pull the entity itself (list / template / workspace —
            // same machinery per ADR 0011).
            const entity = getElementById(this.sql, listId);

            if (!entity || !isEntityRowType(entity.type)) {
                throw new NotFoundError(`entity not found: ${listId}`);
            }
            resolvedEntityVersion = entity.version;
        }

        if (requestVersion === 0) {
            // Initialize a fresh client by adding a "clear" action as our
            // first patch. That will clear the Replicache client, so we
            // start from scratch. (Not sure this is entirely necessary...)
            pullResponse.patch.push({
                op: 'clear',
            });
        }

        for (const element of listElements) {
            const key = element.id;

            if (element.time_deleted) {
                // Don't add a "del" operation to the list if we're
                // building a "from scratch" patch, because you only
                // need to delete things if you already have them.
                if (requestVersion === 0) continue;

                pullResponse.patch.push({
                    key,
                    op: 'del',
                });
            } else {
                pullResponse.patch.push({
                    key,
                    op: 'put',
                    value: {
                        ...element,
                        time_created: element.time_created.toISOString(),
                        time_deleted: null,
                        time_updated: element.time_updated.toISOString(),
                    },
                });
            }
        }

        // ADR 0009 Slice 2: append role-gated keyspaces (e.g.
        // `pending_invites/*`). The orchestration handles promotion
        // (full sync from version 0 if this role newly gained visibility),
        // demotion (emit `del` for every key the prior role could see
        // that the current role can't), and steady-state diffing.
        pullResponse.patch.push(
            ...appendKeyspacePatches({
                keyspaces: LIST_PULL_KEYSPACES,
                sql: this.sql,
                currentRole: authorizedRole,
                previousRole,
                previousVersion: requestVersion,
            })
        );

        // Emit the role-versioned cookie. The client carries it
        // verbatim into the next pull, where its `r` powers the
        // demotion-eviction path in the keyspaces orchestrator.
        pullResponse.cookie = encodePullCookie({
            v: resolvedEntityVersion,
            r: authorizedRole,
        });

        console.log(
            `Patch count to get from v${requestVersion} to v${resolvedEntityVersion}:`,
            pullResponse.patch.length
        );

        // return new Response(JSON.stringify(pullResponse), {
        //     status: 200,
        //     headers: { 'Content-Type': 'application/json' },
        // });

        return pullResponse;
    }

    /**
     * Async preflight for mutators that need cross-DO / cross-entity
     * D1 state to make their decision (ADR 0009 Slice 3; ADR 0011
     * §Step 7b.5 for `setWorkspaceSlug`). The single-entity DO has
     * no synchronous SQL access to D1, but `_handlePush` is async —
     * so checks that need D1 (invitation rate limits, identity
     * resolution, slug uniqueness across other workspaces) live
     * HERE, inside the DO, just before the synchronous mutator
     * runs. Previously the preflight lived
     * at the HTTP `/push` boundary and rejected the whole push with
     * a structured 4xx; that wedged Replicache's retry loop on
     * permanent failures (no client-side API drops a pending
     * mutation). Moving preflight into the DO lets us skip-and-ack
     * the failed mutation — the lastMutationID advances, the push
     * succeeds at the HTTP layer, and the failure surfaces over the
     * outcome channel as a typed `{status, reason, message}` payload.
     *
     * Returns:
     *   - `{ ok: true }` to let `handleMutation` run normally.
     *   - `{ ok: false, ... }` so the caller can skip-and-ack and
     *     emit a structured outcome. The status maps onto the
     *     existing `MutationOutcomeStatus` taxonomy (`auth` for
     *     identity / session failures, `gone` for target-missing,
     *     `precondition` for everything else).
     */
    private async runMutationPreflight(
        mutation: MutationV1,
        authorizedAccounts: Readonly<Account[]>,
        authorizedRole: AuthorizationRole
    ): Promise<
        | { ok: true }
        | {
              ok: false;
              status: MutationOutcomeStatus;
              reason: string;
              message: string;
          }
    > {
        const d1 = (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH;
        const sessionAccountIds = authorizedAccounts.map(a => a.id);
        const args = (mutation.args ?? {}) as Record<string, unknown>;

        if (mutation.name === 'inviteByIdentity') {
            const kindParsed = InvitationIdentityKindEnum.safeParse(
                args.identity_kind
            );
            if (!kindParsed.success) return { ok: true }; // mutator's argsSchema rejects
            const identity_value =
                typeof args.identity_value === 'string'
                    ? args.identity_value
                    : '';
            const inviter_account_id =
                typeof args.accountId === 'string' ? args.accountId : null;

            // Read the entity's current rules straight from the DO sql.
            // No D1 round-trip for this lookup; the DO is authoritative.
            const entityId = getEntityId(this.sql);
            const entity = entityId
                ? getElementById(this.sql, entityId)
                : null;
            const rules =
                entity && isEntityRow(entity)
                    ? entity.authorization_rules
                    : null;

            const result = await preflightInviteByIdentity(
                {
                    countInvitesByInviterSince: (a, since) =>
                        CountInvitesByInviterSince(d1, a, since),
                    countOutstandingInvitesByInviter: a =>
                        CountOutstandingInvitesByInviter(d1, a),
                    getAccountIdByEmail: async email => {
                        if (!email) return null;
                        const account = await GetAccountByEmail(d1, email);
                        return account?.id ?? null;
                    },
                },
                {
                    inviter_account_id,
                    identity_kind: kindParsed.data,
                    identity_value,
                    authorization_rules: rules,
                    sessionAccountIds,
                    nowSeconds: Math.floor(Date.now() / 1000),
                }
            );
            if (result.ok) return { ok: true };
            return {
                ok: false,
                status: inviteReasonToOutcomeStatus(result.reason),
                reason: result.reason,
                message: result.message,
            };
        }

        if (mutation.name === 'setWorkspaceSlug') {
            // ADR 0011 §Step 7b.5: the preflight is the actual D1
            // write — `tryClaimSlug` runs an atomic guarded UPDATE
            // against the `UNIQUE(type, slug)` index, so by the time
            // the synchronous mutator runs the slug column on the D1
            // catalog has already swapped (or the mutation gets
            // skip-and-ack'd here with a structured outcome). The
            // mutator's role is purely to bump version + time_updated
            // on the DO entity row so the post-commit snapshot emit
            // fires.
            //
            // The role gate has to be replicated here. The
            // synchronous mutator dispatcher (`handleMutation`)
            // checks `requiredRole` AFTER the preflight has already
            // run, so without this guard a non-admin caller could
            // vandalize the slug (the mutator's own write would be
            // rejected but the preflight's D1 UPDATE already
            // committed). Same pattern the invitation preflight uses
            // for its session check.
            if (!OWNER_ROLES.includes(authorizedRole)) {
                return {
                    ok: false,
                    status: 'auth',
                    reason: 'unauthorized_role',
                    message: `Role "${authorizedRole}" cannot change a workspace slug; admin or owner required.`,
                };
            }
            const workspaceId =
                typeof args.workspaceId === 'string' ? args.workspaceId : '';
            const newSlug =
                typeof args.slug === 'string' ? args.slug : '';
            if (!workspaceId || !newSlug) {
                // Malformed args; let the mutator's argsSchema reject.
                return { ok: true };
            }
            const result = await tryClaimSlug(
                d1,
                workspaceId,
                'workspace',
                newSlug,
            );
            if (result.ok) return { ok: true };
            return {
                ok: false,
                status: slugReasonToOutcomeStatus(result.reason),
                reason: result.reason,
                message: result.message,
            };
        }

        if (mutation.name === 'acceptInvitation') {
            const kindParsed = InvitationIdentityKindEnum.safeParse(
                args.identity_kind
            );
            if (!kindParsed.success) return { ok: true };
            const identity_value =
                typeof args.identity_value === 'string'
                    ? args.identity_value
                    : '';
            const acceptor_account_id =
                typeof args.accountId === 'string' ? args.accountId : null;
            const target_id =
                typeof args.listId === 'string' ? args.listId : '';

            const result = await preflightAcceptInvitation(
                {
                    getInvitationFromIndex: (targetId, kind, value) =>
                        GetInvitationFromIndex(d1, {
                            targetId,
                            identity_kind: kind,
                            identity_value: value,
                        }),
                },
                {
                    acceptor_account_id,
                    target_id,
                    identity_kind: kindParsed.data,
                    identity_value,
                    sessionAccounts: authorizedAccounts.map(a => ({
                        id: a.id,
                        email: a.email,
                        email_verified: a.email_verified,
                    })),
                    nowSeconds: Math.floor(Date.now() / 1000),
                }
            );
            if (result.ok) return { ok: true };
            return {
                ok: false,
                status: acceptReasonToOutcomeStatus(result.reason),
                reason: result.reason,
                message: result.message,
            };
        }

        return { ok: true };
    }

    /**
     * Handles a Push request from Replicache by evaluating each of
     * the request's mutations.
     */
    public handlePush(args: {
        authorizedAccounts: Readonly<Account[]>;
        authorizedRole: AuthorizationRole;
        listId: string;
        pushRequest: PushRequestV1;
    }) {
        return tryCatchAsync(this._handlePush(args));
    }

    public async _handlePush({
        authorizedAccounts,
        authorizedRole,
        listId,
        pushRequest,
    }: {
        authorizedAccounts: Readonly<Account[]>;
        authorizedRole: AuthorizationRole;
        listId: string;
        pushRequest: PushRequestV1;
    }) {
        // TODO: auth check?
        // console.log('args:', arguments);

        // let list: List;

        // try {
        //     // HMM instead we just need the next_mutation_id
        //     // so can we just pull that from the mutations table?
        //     const element = getElementById(this.sql, listId);

        //     if (element?.type === 'list') {
        //         list = element;
        //         console.log('`handlePush()` we got a list:', list);
        //     } else {
        //         // TODO: remove log
        //         console.log('WE HAVE NO LIST?!');

        //         // this.dropTables();

        //         throw new UnexpectedError();
        //     }
        // } catch (error) {
        //     // Tables are now initialized in the constructor
        //     // if (
        //     //     error?.toString() ===
        //     //         'Error: no such table: list_elements: SQLITE_ERROR' &&
        //     //     pushRequest.mutations.length > 0 &&
        //     //     pushRequest.mutations[0].id === 1 &&
        //     //     pushRequest.mutations[0].name === 'initList'
        //     // ) {
        //     //     list = this.handleInitList(listId, pushRequest);
        //     // } else
        //     if (error instanceof BadMutationError) {
        //         // TODO: figure out what led us to here, and what needs doing about it.
        //         // Probably need to skip this mutation...? hmm
        //         this.dropTables();
        //         throw error;
        //     } else if (error instanceof DjibbError) {
        //         throw error;
        //     } else {
        //         console.log('unhandled error getting the List itself:', error);
        //         throw error;
        //     }
        // }

        let listVersion = getListVersion(this.sql);

        let replicacheClientGroup;
        try {
            replicacheClientGroup = getReplicacheClientGroupById(
                this.sql,
                pushRequest.clientGroupID
            );
        } catch (error) {
            // TODO: update the logic below, probably dont need it?
            // if (
            //     error?.toString() ===
            //     'Error: no such table: replicache_client_groups: SQLITE_ERROR'
            // ) {
            //     this.dropTables();
            // }
            console.log(
                `\`handlePush()\` unexpected error getting replicacheClientGroup "${pushRequest.clientGroupID}":`,
                error
            );

            throw new UnexpectedError();
        }

        if (!replicacheClientGroup) {
            console.log(
                `\`handlePush()\` no Client Group found for ID "${pushRequest.clientGroupID}"`
            );

            replicacheClientGroup = {
                accountId: null,
                clients: [],
                id: pushRequest.clientGroupID,
            };
        }

        console.log(
            `begin processing ${pushRequest.mutations.length} mutations`
        );

        // Tracks whether any successful mutation in this push touched
        // entity-level metadata fields. The DO emits a snapshot to the
        // D1 read index post-commit per ADR 0003. For now the only
        // entity-mutating mutator is `initList`; renameList / archive /
        // setListAuthRules will join this list as they land.
        let entityMetadataMutated = false;
        // Tracks whether this push just soft-deleted a Workspace entity.
        // ADR 0008: a workspace's own `archiveList` is the trigger for
        // the cascade-archive sweep — the post-commit tail enqueues a
        // `cascade-archive` alarm event, which the dispatcher then
        // drives in N=10 batches against the workspace's children
        // (lists + templates). The cascade fan-out is async by design
        // so the user's click returns instantly regardless of how many
        // children the workspace owns.
        let cascadeArchiveTriggered = false;
        // Tracks whether this push just restored a Workspace entity.
        // ADR 0008 §"Restore" mirrors the archive path: an
        // `unarchiveList` against the workspace's own id enqueues the
        // `cascade-restore` event. The two triggers cancel each
        // other's pending events so a mid-sweep flip (Delete then
        // Restore inside seconds) doesn't leave the dispatcher
        // chasing the older direction.
        let cascadeRestoreTriggered = false;
        // Tracks whether any mutation in this push touched the DO's
        // `pending_invites` table. Triggers the post-commit
        // reconciliation emit to `entity_invitations_index` (ADR 0009).
        let invitationsMutated = false;
        // Tracks (identity_kind, identity_value) pairs whose
        // pending_invite row was accepted in this push. Each gets a
        // direct UPDATE to D1 (`status='accepted'`) BEFORE the
        // reconciler runs, so the "missing in DO ⇒ revoked" diff
        // doesn't downgrade the row.
        const acceptedInvites: Array<{
            identity_kind: InvitationIdentityKind;
            identity_value: string;
        }> = [];
        // Tracks (identity_kind, identity_value, inviter_account_id)
        // for every `inviteByIdentity` mutation that successfully
        // committed in this push. Drained post-commit to fire
        // notification emails per ADR 0009 §"Email send". Stored
        // separately from the reconciler input so we never fire on a
        // mutation that was skipped/rolled back.
        const sentInvites: Array<{
            identity_kind: InvitationIdentityKind;
            identity_value: string;
            inviter_account_id: string;
        }> = [];

        for (let i = 0; i < pushRequest.mutations.length; i++) {
            const mutation = pushRequest.mutations[i];

            // Could move the parsing from handleMutation up to here, but...
            if (!mutation) throw new BadMutationError();

            console.log(
                `processing mutation #${i + 1}: ${mutation.name} next mutation: ${pushRequest.mutations?.[i + 1]?.name || 'NULL'}`
            );

            // Pull the ReplicacheClient for this mutation's Client ID.
            // Initialize it, if needed. We'll persist it later.
            let replicacheClient = replicacheClientGroup.clients.find(
                client => client.id === mutation.clientID
            );

            if (!replicacheClient) {
                console.log(
                    `\`handlePush()\` ReplicacheClient not found for "${mutation.clientID}". Initializing! (btw, mutation.id is ${mutation.id}.)`
                );

                replicacheClient = {
                    id: mutation.clientID,
                    // Default to 0. I think that should be fine... There's a
                    // possibility we should default to the `mutation.id`, but
                    // I don't know enough. Leave it like this for now.
                    lastMutationId: 0,
                    lastModifiedVersion: 0,
                };

                // Should we set `replicacheClient` into `replicacheClientGroup.clients` here...?
                replicacheClientGroup.clients.push(replicacheClient);
            }

            // Each mutation is created by a ReplicacheClient. We want
            // to ensure we process each mutation in order, just like
            // they happened on the Client. Replicache helps us do
            // just that by assigning each Mutation an ID on the frontend.
            // The ID is a number that is incremented for each Mutation,
            // just like an auto-increment column in SQL.
            //
            // On the backend, we track the last Mutation ID each
            // ReplicacheClient we've processed. That way, we can check
            // that each Mutation we're about to process is the right
            // one, and not one out of order. Move in sync!
            //
            // Calculate the expected Mutation ID for this Client by
            // simply adding 1 to the last known ID.
            const expectedMutationId = replicacheClient.lastMutationId + 1;

            // `nextVersion` is the list version that this mutation
            // will produce if it succeeds. It's independent of the
            // per-client mutation ID.
            const nextVersion = listVersion + 1;

            // Async preflight for mutators that depend on D1 state
            // (invitation-family per ADR 0009 Slice 3, setWorkspaceSlug
            // per ADR 0011 §Step 7b.5). On failure: skip-and-ack the
            // mutation, emit a structured outcome with the reason
            // string + human-readable message, persist a 'skipped'
            // log row, and continue. The lastMutationID advances so
            // Replicache stops retrying; the failure surfaces over
            // the outcome channel rather than as a wedged push.
            if (
                expectedMutationId === mutation.id &&
                PREFLIGHTED_MUTATORS.has(mutation.name)
            ) {
                const preflight = await this.runMutationPreflight(
                    mutation,
                    authorizedAccounts,
                    authorizedRole
                );
                if (!preflight.ok) {
                    this.emitMutationOutcome(
                        mutation.clientID,
                        mutation.id,
                        preflight.status,
                        {
                            reason: preflight.reason,
                            message: preflight.message,
                        }
                    );
                    // Persist a skipped envelope so the mutation log
                    // captures the rejection (same posture as
                    // `handleMutation`'s skipped path). Best-effort.
                    const envelopeResult = parseMutationEnvelope(mutation);
                    if (envelopeResult.ok) {
                        const { envelope, rawBody } = envelopeResult.mutation;
                        try {
                            setMutation(this.sql, envelope, rawBody, 'skipped');
                        } catch (error) {
                            console.log(
                                '`_handlePush()` preflight skip setMutation log error:',
                                error?.toString()
                            );
                        }
                    }
                    // Advance lastMutationID just like `handleMutation`
                    // does for skipped/unauthorized envelopes — without
                    // this, Replicache would retry the push forever.
                    replicacheClient.lastMutationId = mutation.id;
                    replicacheClient.lastModifiedVersion = listVersion;
                    console.log({
                        ackedMutationId: mutation.id,
                        didMutate: false,
                        listVersion,
                        preflightReason: preflight.reason,
                    });
                    continue;
                }
            }

            const { ackedMutationId, didMutate } = this.handleMutation(
                authorizedAccounts,
                authorizedRole,
                expectedMutationId,
                mutation,
                nextVersion
            );

            if (didMutate) {
                listVersion = nextVersion;
                if (ENTITY_METADATA_MUTATORS.has(mutation.name)) {
                    entityMetadataMutated = true;
                }
                // ADR 0008 §"Trigger": a successful `archiveList`
                // mutation against this DO's own workspace entity is
                // the cascade-archive trigger. The ID-prefix check
                // narrows to workspace entities — list and template
                // archives stay self-contained. `listId` is the outer
                // function param and matches this DO's entity id (the
                // mutator's `args.listId` is required to equal it).
                if (
                    mutation.name === 'archiveList' &&
                    listId.startsWith('w/')
                ) {
                    cascadeArchiveTriggered = true;
                }
                // ADR 0008 §"Restore": symmetric trigger. An
                // unarchive against the workspace's own id flips the
                // dispatcher into restore mode. The cascade-archive
                // event (if any pending from a prior delete) gets
                // canceled in the post-commit tail, so the dispatcher
                // doesn't keep archiving children that are about to
                // be restored.
                if (
                    mutation.name === 'unarchiveList' &&
                    listId.startsWith('w/')
                ) {
                    cascadeRestoreTriggered = true;
                }
                if (INVITATION_MUTATORS.has(mutation.name)) {
                    invitationsMutated = true;
                }
                if (mutation.name === 'inviteByIdentity') {
                    // Capture sent invites so the post-commit tail can
                    // fire notification emails. Pull (kind, value,
                    // inviter) directly off the wire args — the mutator
                    // already parsed + role-gated, and the preflight
                    // verified the inviter is in-session.
                    const rawArgs = (mutation.args ?? {}) as Record<
                        string,
                        unknown
                    >;
                    const kindParse = InvitationIdentityKindEnum.safeParse(
                        rawArgs.identity_kind
                    );
                    const valueRaw = rawArgs.identity_value;
                    const inviterRaw = rawArgs.accountId;
                    if (
                        kindParse.success &&
                        typeof valueRaw === 'string' &&
                        typeof inviterRaw === 'string'
                    ) {
                        sentInvites.push({
                            identity_kind: kindParse.data,
                            identity_value: normalizeIdentityValue(
                                kindParse.data,
                                valueRaw
                            ),
                            inviter_account_id: inviterRaw,
                        });
                    }
                }
                if (mutation.name === 'acceptInvitation') {
                    // Pull the (kind, value) directly off the wire
                    // args. The mutator already parsed + role-gated
                    // above, so we trust the args' shape here; a
                    // belt-and-suspenders zod parse keeps the cast
                    // honest.
                    const rawArgs = (mutation.args ?? {}) as Record<
                        string,
                        unknown
                    >;
                    const kindParse = InvitationIdentityKindEnum.safeParse(
                        rawArgs.identity_kind
                    );
                    const valueRaw = rawArgs.identity_value;
                    if (kindParse.success && typeof valueRaw === 'string') {
                        acceptedInvites.push({
                            identity_kind: kindParse.data,
                            identity_value: normalizeIdentityValue(
                                kindParse.data,
                                valueRaw
                            ),
                        });
                    }
                }
            }
            if (ackedMutationId !== null) {
                replicacheClient.lastMutationId = ackedMutationId;
                replicacheClient.lastModifiedVersion = listVersion;
            }
            console.log({ ackedMutationId, didMutate, listVersion });
        }

        // Save the Replicache Client Group.
        setReplicacheClientGroup(this.sql, replicacheClientGroup);

        setListVersion(this.sql, listVersion);

        // Emit current entity snapshot to the D1 read index (ADR 0003).
        // Synchronous on the request: the worker's middleware reads D1
        // for auth on subsequent requests, so the next round-trip needs
        // D1 to be caught up. The push path is fire-and-pray on failure
        // — the DO is already committed and authoritative, and the
        // reconciliation alarm (ADR 0007) repairs persistent drift.
        // We catch here rather than letting the throw mark the push
        // failed, since a successful mutation should still ack to the
        // client even if its D1 projection lagged.
        if (entityMetadataMutated) {
            try {
                await this.emitEntitySnapshot(listId);
            } catch (error) {
                console.error(
                    `\`emitEntitySnapshot()\` D1 emit failed for "${listId}":`,
                    error
                );
            }
        }

        // Flip D1 index rows to `status='accepted'` for each accepted
        // invite BEFORE the reconciler's snapshot diff runs (ADR 0009
        // Slice 3). Order matters: the reconciler converts D1 'pending'
        // rows that have no DO counterpart to 'revoked'; the accepted
        // rows have been tombstoned in the DO, so without this update
        // they'd be misclassified as revoked. Fire-and-pray on D1
        // failure — same posture as the snapshot below.
        if (acceptedInvites.length > 0) {
            try {
                await MarkInvitationsAccepted(
                    (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH,
                    listId,
                    acceptedInvites
                );
            } catch (error) {
                console.error(
                    `\`MarkInvitationsAccepted()\` D1 emit failed for "${listId}":`,
                    error
                );
            }
        }

        // Reconcile invitation index post-commit (ADR 0009). Full-snapshot
        // diff: DO rows become D1 'pending', any D1 'pending' rows
        // absent from the DO become 'revoked'. Same fire-and-pray
        // posture as the entity-metadata emit — DO is authoritative
        // and the reconciliation alarm is the eventual repair.
        if (invitationsMutated) {
            try {
                await this.emitInvitationsSnapshot(listId);
            } catch (error) {
                console.error(
                    `\`emitInvitationsSnapshot()\` D1 emit failed for "${listId}":`,
                    error
                );
            }
        }

        // Fire invitation notification emails for any inviteByIdentity
        // mutations that committed in this push (ADR 0009 §"Email
        // send"). Best-effort: a delivery failure is logged but doesn't
        // affect the push response — the invite still exists in the DO
        // + D1 index and the invitee can be re-notified by another
        // surface (resend button, future inbox). Email lookup is keyed
        // by the entity row + the inviter's display_name on the session
        // we already have in scope, so no extra D1 reads.
        if (sentInvites.length > 0) {
            await this.fireInvitationEmails(
                listId,
                sentInvites,
                authorizedAccounts
            );
        }

        // ADR 0008 §"Trigger": enqueue the cascade-archive event for
        // immediate fire. The handler reads this workspace's child
        // catalog and fans out `cascadeArchiveList` pushes in N=10
        // batches; if more children remain after a batch it re-arms
        // itself. Idempotent re-scheduling: scheduling the same event
        // again (e.g. a retry archive on an already-deleted workspace)
        // just resets the dueAt to "now," which is harmless. We
        // schedule AFTER `emitEntitySnapshot` so the workspace's own
        // `time_deleted` is already in the catalog before any child
        // begins its sweep — useful for the read paths (Trash UI,
        // future "this list is in a deleted workspace" hint) that
        // consult both rows.
        //
        // Mid-restore re-archive: also cancel any pending
        // cascade-restore event. The dispatcher would self-abort on
        // the next tick (the handler checks the workspace's own
        // `time_deleted`), but canceling here drops the storage key
        // immediately and avoids a pointless alarm fire.
        if (cascadeArchiveTriggered) {
            try {
                await this.cancelEvent('cascade-restore');
                await this.scheduleEvent('cascade-archive', Date.now());
            } catch (error) {
                console.error(
                    `\`scheduleEvent('cascade-archive')\` failed for "${listId}":`,
                    error
                );
            }
        }

        // ADR 0008 §"Restore": symmetric to the archive trigger.
        // Cancels any pending cascade-archive (mid-sweep flip) and
        // enqueues cascade-restore for immediate fire.
        if (cascadeRestoreTriggered) {
            try {
                await this.cancelEvent('cascade-archive');
                await this.scheduleEvent('cascade-restore', Date.now());
            } catch (error) {
                console.error(
                    `\`scheduleEvent('cascade-restore')\` failed for "${listId}":`,
                    error
                );
            }
        }

        // Bootstrap the reconciliation alarm per ADR 0007. Idempotent;
        // ensureReconcileAlarm() no-ops when an alarm is already
        // scheduled. Runs on every push so a DO that came up before
        // ADR 0007 (or one whose alarm storage was cleared by a
        // migration) picks the schedule back up on its next touch.
        await this.ensureReconcileAlarm();

        this.poke();

        // Replicache: the response body to the push endpoint is
        // ignored.
        // return Promise.resolve();
    }

    /**
     * This must handle its own errors, because we will skip any failed
     * mutations yet log them still, otherwise Replicache will continue
     * to send the mutation.
     */
    handleMutation(
        authorizedAccounts: Readonly<Account[]>,
        authorizedRole: AuthorizationRole,
        expectedMutationId: number,
        mutation: MutationV1,
        nextVersion: number
    ): { ackedMutationId: number | null; didMutate: boolean } {
        // Check the Mutation's ID matches the Expected ID.
        if (expectedMutationId !== mutation.id) {
            console.log(
                expectedMutationId > mutation.id
                    ? `Mutation from the past! Expected "${expectedMutationId}" Got "${mutation.id}"`
                    : `Mutation from the future! Expected "${expectedMutationId}" Got "${mutation.id}"`
            );
            // From-the-past mutations have already been processed; ack
            // them so Replicache stops resending. From-the-future
            // mutations are wedged; don't ack.
            return {
                ackedMutationId:
                    expectedMutationId > mutation.id ? mutation.id : null,
                didMutate: false,
            };
        }

        // Parse the wire envelope first so envelope-level checks
        // (cross-account auth, log persistence) read from a typed
        // shape instead of re-fishing fields out of `mutation.args`.
        const envelopeResult = parseMutationEnvelope(mutation);
        if (!envelopeResult.ok) {
            console.log(
                `\`handleMutation()\` envelope parse failed: ${envelopeResult.reason}`
            );
            // Skip-and-ack: malformed envelopes can't be replayed
            // usefully, and not acking would wedge the client.
            return { ackedMutationId: mutation.id, didMutate: false };
        }
        const { envelope, rawBody } = envelopeResult.mutation;

        // Cross-account check: a mutation may claim an `accountId`
        // (for offline / multi-account flows). If it does, that account
        // must be one the session is signed in as. Envelope-level
        // concern, handled before execute.
        if (
            envelope.accountId &&
            !authorizedAccounts.some(a => a.id === envelope.accountId)
        ) {
            throw new UnauthorizedError(`${envelope.id} not authorized`);
        }

        let mutationStatus: MutationStatus = 'unknown';

        try {
            const result = executeServerMutation(envelopeResult.mutation, {
                sql: this.sql,
                role: authorizedRole,
                nextVersion,
            });

            if (result.ok) {
                mutationStatus = 'succeeded';
                // Surface failure outcomes (CAS-stale, target-gone)
                // over the per-mutation outcome channel so the client's
                // undo runtime (B.2) can update its toast / abort
                // pending retry. Successes are implicit — no emit.
                if (result.outcome !== 'applied') {
                    this.emitMutationOutcome(
                        envelope.clientID,
                        envelope.id,
                        result.outcome
                    );
                }
            } else if (result.status === 'unauthorized') {
                console.log(
                    `\`handleMutation()\` unauthorized: ${result.reason}`
                );
                // Emit `auth` over the outcome channel BEFORE throwing.
                // The HTTP push response will fail too; the channel
                // gives the runtime a structured per-mutation
                // signal so it can stop retrying that envelope.
                this.emitMutationOutcome(
                    envelope.clientID,
                    envelope.id,
                    'auth'
                );
                throw new UnauthorizedError(result.reason);
            } else {
                console.log(
                    `\`handleMutation()\` skipped "${envelope.name}": ${result.reason}`
                );
                mutationStatus = 'skipped';
            }
        } catch (error) {
            console.error(
                `\`handleMutation()\` error executing "${envelope.name}":`,
                error
            );

            if (error instanceof UnauthorizedError) {
                throw error;
            } else if (error instanceof DjibbError) {
                mutationStatus = 'skipped';
            } else {
                mutationStatus = 'error';
                throw new UnexpectedError();
            }
        }

        // Best-effort log of skipped/succeeded mutations. Envelope
        // fields land in their dedicated columns; only the body is
        // serialized into `args`.
        if (mutationStatus === 'succeeded' || mutationStatus === 'skipped') {
            try {
                setMutation(this.sql, envelope, rawBody, mutationStatus);
            } catch (error) {
                console.log(
                    '`handleMutation()` setMutation log error:',
                    error?.toString()
                );
            }
        }

        return {
            ackedMutationId: mutation.id,
            didMutate: mutationStatus === 'succeeded',
        };
    }

    public fetch(request: Request) {
        // TODO: not sure this works with the new Hono routing?
        if (request.method === 'GET' && request.url.includes('websocket')) {
            return this.handleWebSocket(request);
        }

        return new Response('invalid Durable Object fetch request', {
            status: 400,
        });
    }

    /**
     * Handles requests for initiating a websocket connection.
     *
     * Calling `acceptWebSocket()` informs the runtime that this WebSocket
     * is to begin terminating request within the Durable Object. It has
     * the effect of "accepting" the connection, and allowing the
     * WebSocket to send and receive messages. Unlike `ws.accept()`,
     * `ctx.acceptWebSocket(ws)` informs the Workers Runtime that the
     * WebSocket is "hibernatable", so the runtime does not need to pin
     * this Durable Object to memory while the connection is open. During
     * periods of inactivity, the Durable Object can be evicted from
     * memory, but the WebSocket connection will remain open. If at some
     * later point the WebSocket receives a message, the runtime will
     * recreate the Durable Object (run the `constructor`) and deliver
     * the message to the appropriate handler.
     * @see https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
     */
    public async handleWebSocket(request: Request): Promise<Response> {
        // Requests to the websocket endpoint should be an "upgrade"
        // request. Check for the corresponding header.
        const headerUpgrade = request.headers.get('Upgrade');
        if (headerUpgrade !== 'websocket') {
            console.log('missing websocket upgrade header!');

            return new Response(
                'Expected request header `Upgrade: websocket`.',
                { status: 426 }
            );
        }

        // Get the client's security key, which is an important part of
        // the WebSocket handshake.
        const headerSecWebSocketKey = request.headers
            .get('Sec-WebSocket-Key')
            ?.trim();

        // Prevent abuse by giving us a SUPER long key to process.
        // I think the general key length is 24.
        const MAX_LENGTH_SEC_KEY = 30;

        if (
            !headerSecWebSocketKey ||
            headerSecWebSocketKey.length > MAX_LENGTH_SEC_KEY
        ) {
            return new Response(
                'Expected request header `Sec-WebSocket-Key`.',
                { status: 400 }
            );
        }

        // The Websocket standard requires that the WebSocket server
        // jump through some security hoops to help ensure that the
        // client has made a request to a good WebSocket server, which
        // would of course have the below GUID, and know to append that
        // GUID to the request's `Sec-WebSocket-Key` header.
        //
        // It seems this part of the handshake helps prevent cached
        // responses to a WebSocket request, while also demonstrating
        // that the server knows a thing or two about WebSockets.
        const WEB_SOCKET_SECURITY_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

        // Concatenate the request's key with the GUID, then encode it
        // for hashing (also called calculating a "digest").
        const combinedKeyEncoded = new TextEncoder().encode(
            headerSecWebSocketKey + WEB_SOCKET_SECURITY_GUID
        );

        const hashedBuffer = await crypto.subtle.digest(
            'SHA-1',
            combinedKeyEncoded
        );

        // Convert the Array Buffer to a Base64-encoded string.
        // https://stackoverflow.com/questions/9267899/arraybuffer-to-base64-encoded-string
        let binary = '';
        const bytes = new Uint8Array(hashedBuffer);
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        const wsAcceptKey = btoa(binary);

        // Create the two ends of a WebSocket connection.
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        if (!server) {
            throw new UnexpectedError('bad server from WebSocketPair');
        }

        // Read `?c=<clientID>` to tag this socket at accept time. Per
        // ADR 0006, the tag is what `getWebSockets(clientID)` keys
        // off when emitting per-mutation outcomes. Untagged upgrades
        // are accepted (graceful-deploy invariant) — old clients
        // that don't supply `c` keep working for poke broadcasts;
        // they just don't receive outcomes.
        const url = new URL(request.url);
        const clientID = url.searchParams.get(WS_QUERY_CLIENT_ID);
        if (clientID && clientID.length > 0 && clientID.length <= 128) {
            this.ctx.acceptWebSocket(server, [clientID]);
        } else {
            this.ctx.acceptWebSocket(server);
        }

        return new Response(null, {
            headers: {
                'Sec-WebSocket-Accept': wsAcceptKey,
            },
            status: 101,
            webSocket: client,
        });
    }

    /**
     * Emit a snapshot of the entity row to the D1 catalog read index.
     * Per ADR 0003 the DO is the single writer for entity metadata; D1
     * is a derived projection. The emit is current-state UPSERT, not a
     * diff event — the catalog only needs latest state. When the event
     * bus arrives this becomes one subscriber on a fan-out.
     *
     * Throws on D1 emit failure so callers can decide how to react —
     * the push-path caller logs and moves on (fire-and-pray; the DO
     * is already committed, the alarm sweeper will catch persistent
     * drift), while the alarm-path caller lets the throw bubble to
     * its retry-backoff handler. Previously this method swallowed
     * the error itself, which silently masked emit failures from the
     * alarm path's retry logic (ADR 0007).
     *
     * The "entity row missing in this DO's own sql" branch is a
     * separate concern: it's an invariant violation, not a transient
     * fault, so retry would not help. Logged-and-returned, not
     * thrown.
     */
    /**
     * Count the membership rows in D1 for this entity. Used by the
     * alarm to detect the "snapshot emit succeeded but membership emit
     * failed" gap (ADR 0011 §Step 7). Returns 0 on read failure — the
     * comparison upstream will treat that as drift and re-emit, which
     * is the recoverable posture.
     */
    private async countD1Memberships(entityId: string): Promise<number> {
        try {
            const row = await (
                this.env as { DJIBB_AUTH: D1Database }
            ).DJIBB_AUTH.prepare(
                `SELECT COUNT(*) AS n FROM entity_memberships WHERE entity_id = ?`
            )
                .bind(entityId)
                .first<{ n: number }>();
            return row?.n ?? 0;
        } catch (error) {
            console.warn(
                `\`countD1Memberships()\` read failed for "${entityId}":`,
                error
            );
            return 0;
        }
    }

    private async emitEntitySnapshot(entityId: string): Promise<void> {
        const entity = getElementById(this.sql, entityId);
        if (!entity || !isEntityRow(entity)) {
            console.warn(
                `\`emitEntitySnapshot()\` no entity row for "${entityId}"`
            );
            return;
        }

        const d1 = (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH;
        const timeUpdated = Math.floor(entity.time_updated.getTime() / 1000);
        await EmitEntitySnapshotToCatalog(d1, {
            id: entity.id,
            workspace_id: entity.workspace_id,
            type: entity.type,
            name: entity.name,
            description: entity.description ?? null,
            forked_from_id: entity.forked_from_id,
            meta: entity.meta,
            // ADR 0011 §Step 7b.5: slug is optional on the DO entity
            // row (lists/templates currently leave it unset); the
            // projection writer defaults to the id suffix when absent.
            slug: (entity as { slug?: string }).slug,
            slot: entity.slot,
            // ADR 0008 / ADR 0011 §Step 10a.4a: cascade_source lives
            // on the DO row alongside time_deleted; the row is
            // authoritative and the snapshot just mirrors it.
            cascade_source:
                (entity as { cascade_source?: string | null })
                    .cascade_source ?? null,
            authorization_rules: entity.authorization_rules,
            time_created: Math.floor(entity.time_created.getTime() / 1000),
            time_updated: timeUpdated,
            time_deleted: entity.time_deleted
                ? Math.floor(entity.time_deleted.getTime() / 1000)
                : null,
            version: entity.version,
        });

        // ADR 0011 §Step 7: emit the membership projection alongside
        // the entity snapshot. Same fire-and-pray posture — failure is
        // logged by the caller and recovered by the next emit / the
        // reconciliation sweeper. Cheap to over-emit: even mutators
        // that don't touch `authorization_rules` re-publish the same
        // membership rows.
        await EmitEntityMembershipsToCatalog(d1, {
            entityId: entity.id,
            authorizedAccounts: entity.authorization_rules.authorized_accounts,
            timeUpdated,
        });
    }

    /**
     * Reconcile this DO's pending_invites into D1's
     * `entity_invitations_index` (ADR 0009). Called post-commit when a
     * push touched any INVITATION_MUTATORS. Full-snapshot pattern:
     * DO rows are UPSERTed as 'pending'; D1 'pending' rows that no
     * longer correspond to a DO row become 'revoked'.
     *
     * The entity-not-found branch (DO ran an invitation mutator but
     * its own list_elements row is missing) is an invariant violation
     * — logged and skipped, not thrown, mirroring `emitEntitySnapshot`.
     */
    /**
     * Send notification emails for invitations that committed in this
     * push (ADR 0009 §"Email send"). One email per recipient. The
     * `acceptUrl` points directly to the entity page with
     * `?from_invite=1`; the entity route handles its own redirect-to-
     * login for unauthenticated invitees and a future banner picks up
     * the flag to surface an explicit "accept" affordance.
     *
     * Best-effort: failures are logged, never thrown. Concurrent sends
     * are awaited via `Promise.allSettled` so one slow recipient
     * doesn't serialize the rest, and the push response isn't blocked
     * on aggregate latency beyond the slowest send. The DO's input
     * gate keeps the object alive while these promises resolve, so we
     * don't need `executionCtx.waitUntil` here (which isn't available
     * inside the DO anyway).
     */
    private async fireInvitationEmails(
        entityId: string,
        invites: ReadonlyArray<{
            identity_kind: InvitationIdentityKind;
            identity_value: string;
            inviter_account_id: string;
        }>,
        authorizedAccounts: Readonly<Account[]>
    ): Promise<void> {
        const entity = getElementById(this.sql, entityId);
        if (!entity || !isEntityRow(entity)) {
            console.warn(
                `\`fireInvitationEmails()\` no entity row for "${entityId}"`
            );
            return;
        }
        const entityName = (entity as { name?: string }).name ?? '';
        const entityTypeLabel = entity.type;

        const env = this.env as Bindings;
        if (!env.EMAIL) {
            console.warn(
                '`fireInvitationEmails()` no EMAIL binding; skipping send.'
            );
            return;
        }

        // First domain in the semicolon-separated list is treated as
        // canonical for outbound links (matches the workspace-invite
        // pattern in `workspace/fetch.ts`).
        const origin = (env.AUTHORIZED_DOMAINS ?? '').split(';')[0] ?? '';
        if (!origin) {
            console.warn(
                '`fireInvitationEmails()` no AUTHORIZED_DOMAINS; using relative URL.'
            );
        }
        // URL prefix mirrors the entity ID's type prefix (`l/`, `t/`, `w/`)
        // — see user memory note "URLs mirror ID type prefixes".
        const pathPrefix =
            entityTypeLabel === 'list'
                ? '/l/'
                : entityTypeLabel === 'workspace'
                  ? '/w/'
                  : '/t/';
        // ID prefix lives in the entity id (`l/<suffix>` / `t/<suffix>`)
        // but the URL form strips the prefix segment (see user memory:
        // URLs mirror ID type prefixes — `/l/<suffix>` not `/l/l/<suffix>`).
        const idSuffix = entityId.includes('/')
            ? entityId.split('/')[1]
            : entityId;
        const acceptUrl = `${origin}${pathPrefix}${idSuffix}?from_invite=1`;

        const sends = invites.map(async invite => {
            // v1 only supports email-kind identities.
            if (invite.identity_kind !== 'email') return;
            const inviter = authorizedAccounts.find(
                a => a.id === invite.inviter_account_id
            );
            const inviterName = inviter?.display_name ?? '';
            try {
                await sendEntityInvitationEmail(env, {
                    to: invite.identity_value,
                    entityTypeLabel,
                    entityName,
                    inviterName,
                    acceptUrl,
                });
            } catch (error) {
                console.error(
                    `\`sendEntityInvitationEmail()\` failed for "${entityId}" -> "${invite.identity_value}":`,
                    error
                );
            }
        });
        await Promise.allSettled(sends);
    }

    private async emitInvitationsSnapshot(entityId: string): Promise<void> {
        const entity = getElementById(this.sql, entityId);
        if (!entity || !isEntityRow(entity)) {
            console.warn(
                `\`emitInvitationsSnapshot()\` no entity row for "${entityId}"`
            );
            return;
        }

        const doInvites = listPendingInvites(this.sql);
        await EmitInvitationsSnapshot(
            (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH,
            {
                targetId: entityId,
                targetType: entity.type,
                doInvites,
                newIdForRow: () => newId('invitation'),
            }
        );
    }

    /**
     * Reconciliation cadence per ADR 0007. The healthy interval is
     * 24h — the synchronous post-commit emit handles freshness, so
     * the alarm only buys recovery time after a missed emit. The
     * retry path uses exponential backoff from 5min and caps at the
     * healthy interval, so a partial-D1 outage doesn't quietly
     * stockpile retry attempts.
     *
     * Exposed as static so tests can reference them without
     * instantiating the DO.
     */
    static readonly RECONCILE_HEALTHY_MS = 24 * 60 * 60 * 1000;
    static readonly RECONCILE_RETRY_INITIAL_MS = 5 * 60 * 1000;
    /** Storage key holding the next retry interval (ms) after a
     *  failed alarm-driven emit. Absent ⇒ last run succeeded. */
    static readonly RECONCILE_RETRY_KEY = 'reconcile:nextRetryMs';

    // ADR 0011 §Step 10a.2 / ADR 0008 §"Hard-delete: per-DO
    // self-destruct via the alarm dispatcher": multi-event alarm
    // dispatcher. The DO has one Cloudflare alarm slot; the dispatcher
    // tracks any number of independent timed events via prefixed
    // storage keys and arms the slot to fire at the earliest pending
    // due time.
    //
    // Event identity → handler is wired in `runAlarmEvent` below. The
    // events that exist today / will exist:
    //   - reconcile        (ADR 0007; here from day one)
    //   - cascade-archive  (ADR 0008, lands in 10a.4 on the Workspace DO)
    //   - cascade-restore  (ADR 0008, lands in 10a.5)
    //   - harddelete       (ADR 0008, lands in 10a.6/10b on every DO)
    //
    // Storage shape: `alarm:<name>:at` → number (ms epoch). Reconcile-
    // specific retry-state (`RECONCILE_RETRY_KEY`) is handler-internal
    // and lives outside the `alarm:` prefix.
    static readonly ALARM_EVENT_KEY_PREFIX = 'alarm:';

    private alarmEventKey(name: AlarmEventName): string {
        return `${DjibbList.ALARM_EVENT_KEY_PREFIX}${name}:at`;
    }

    /**
     * Schedule (or reschedule) an event for `dueAt` ms epoch. Idempotent
     * across re-arming — overwrites any prior due time for the same
     * event. Re-arms the Cloudflare alarm to the earliest pending event
     * after the write.
     */
    private async scheduleEvent(
        name: AlarmEventName,
        dueAt: number
    ): Promise<void> {
        await this.ctx.storage.put(this.alarmEventKey(name), dueAt);
        await this.rearmAlarm();
    }

    /**
     * Cancel a pending event. Re-arms the Cloudflare alarm to the next
     * earliest remaining event (or clears it entirely if none remain).
     */
    private async cancelEvent(name: AlarmEventName): Promise<void> {
        await this.ctx.storage.delete(this.alarmEventKey(name));
        await this.rearmAlarm();
    }

    /**
     * Read every pending event → due-time. Returns an empty Map when
     * nothing is scheduled (the legacy-fire fallback case in `alarm()`
     * relies on this).
     */
    private async readPendingAlarmEvents(): Promise<
        Map<AlarmEventName, number>
    > {
        const entries = await this.ctx.storage.list({
            prefix: DjibbList.ALARM_EVENT_KEY_PREFIX,
        });
        const result = new Map<AlarmEventName, number>();
        for (const [key, dueAt] of entries) {
            const match = key.match(/^alarm:(.+):at$/);
            if (!match || typeof dueAt !== 'number') continue;
            result.set(match[1] as AlarmEventName, dueAt);
        }
        return result;
    }

    /**
     * Set the Cloudflare alarm to the earliest pending event's due
     * time. If nothing is pending, clear the alarm. The dispatcher
     * calls this after every event-list mutation; handlers usually
     * don't need to call it directly (they `scheduleEvent` or
     * `cancelEvent`, which call this internally).
     */
    private async rearmAlarm(): Promise<void> {
        const pending = await this.readPendingAlarmEvents();
        if (pending.size === 0) {
            await this.ctx.storage.deleteAlarm();
            return;
        }
        const earliest = Math.min(...pending.values());
        await this.ctx.storage.setAlarm(earliest);
    }

    /**
     * Schedule the first reconciliation alarm if one isn't already
     * scheduled. Called at the tail of every successful push so a
     * freshly-created DO picks up the schedule on its first
     * interaction; a pre-existing DO that came up before ADR 0007
     * also picks it up on its next push. Idempotent — checks the
     * reconcile event key, not the bare Cloudflare alarm, so the
     * presence of an unrelated event (cascade-archive, harddelete)
     * does not suppress reconcile scheduling.
     */
    private async ensureReconcileAlarm(): Promise<void> {
        const existing = await this.ctx.storage.get<number>(
            this.alarmEventKey('reconcile')
        );
        if (existing !== undefined) return;
        await this.scheduleEvent(
            'reconcile',
            Date.now() + DjibbList.RECONCILE_HEALTHY_MS
        );
    }

    /**
     * Alarm dispatcher (ADR 0011 §Step 10a.2 / ADR 0008). Cloudflare
     * fires this on the single per-DO alarm slot; we route to whatever
     * events are due, then re-arm to the next earliest.
     *
     * Legacy-fire fallback: a pre-existing DO whose alarm was scheduled
     * before this refactor has a Cloudflare alarm but no `alarm:*:at`
     * storage keys. We treat that empty-state fire as a reconcile so
     * reconcile coverage is preserved at deploy time. `handleReconcile`
     * writes its next-fire key, so subsequent fires go through the
     * normal dispatcher path.
     *
     * Handlers are responsible for re-scheduling themselves (or
     * canceling, in the terminal case). The dispatcher does not
     * re-arm a handler after firing it — calling `scheduleEvent` /
     * `cancelEvent` inside the handler does that.
     */
    async alarm(): Promise<void> {
        const now = Date.now();
        const pending = await this.readPendingAlarmEvents();

        if (pending.size === 0) {
            console.warn(
                '`alarm()` legacy fire (no pending events); running reconcile'
            );
            await this.handleReconcile();
            return;
        }

        for (const [name, dueAt] of pending) {
            if (dueAt > now) continue;
            await this.runAlarmEvent(name);
        }
    }

    /**
     * Route a single due event to its handler. Stub for harddelete
     * cancels-and-warns; the real handler arrives in 10b.
     * Cancellation prevents a misconfigured DO from getting stuck
     * firing an unimplemented event.
     */
    private async runAlarmEvent(name: AlarmEventName): Promise<void> {
        switch (name) {
            case 'reconcile':
                await this.handleReconcile();
                return;
            case 'cascade-archive':
                await this.handleCascadeArchive();
                return;
            case 'cascade-restore':
                await this.handleCascadeRestore();
                return;
            case 'harddelete':
                console.warn(
                    `\`alarm()\` event "${name}" has no handler yet; canceling`
                );
                await this.cancelEvent(name);
                return;
        }
    }

    /**
     * Reconciliation handler. Per ADR 0007:
     *
     *   1. Look up this DO's entity ID. If there isn't one, the DO
     *      was scheduled before it owned an entity (shouldn't
     *      happen, but defensive); skip and re-arm at healthy.
     *   2. Read D1's current version. If it matches the DO's (and
     *      membership counts match too — §7), nothing to do —
     *      re-arm at the healthy cadence.
     *   3. Otherwise (drift or missing row) call the same
     *      `emitEntitySnapshot()` the push path uses. The version-
     *      guarded upsert handles concurrent writers.
     *   4. On success: clear retry state, re-arm at healthy.
     *      On failure: re-arm at the retry interval (exp backoff
     *      capped at healthy) so a transient outage doesn't stick.
     *
     * The handler is the only writer of `RECONCILE_RETRY_KEY`. Push
     * handlers don't touch retry state — a fresh successful push
     * implicitly proves D1 is reachable, but we wait until the next
     * alarm to observe that rather than racing it.
     *
     * Re-schedules itself via `scheduleEvent('reconcile', ...)` at
     * the tail. Pre-refactor (10a.2) this method was the entire
     * `alarm()`; it's now invoked by the dispatcher above.
     *
     * Not marked `private` so reconcile-specific tests can invoke it
     * directly — testing `alarm()` itself would require scheduling
     * reconcile at a past dueAt to satisfy the dispatcher's
     * `if (dueAt > now) continue` filter, which conflates handler
     * semantics with dispatcher semantics. Dispatcher-routing tests
     * go through `alarm()`; reconcile-internal tests go through
     * `handleReconcile()`.
     */
    /**
     * Workspace cascade-archive sweep (ADR 0008, ADR 0011 §Step 10a.4b).
     *
     * Runs only on workspace-typed DOs: the trigger in `_handlePush`
     * only enqueues this event when an `archiveList` against a
     * workspace-prefix id commits. The handler reads this workspace's
     * child entities from the D1 catalog
     * (`workspace_entities WHERE workspace_id = self AND time_deleted
     * IS NULL AND cascade_source IS NULL`) in batches of N=10 and
     * dispatches a `cascadeArchiveList` push to each child's DO via
     * synthetic-client RPC (`cascade:<workspaceId>:<deletionTsMs>`
     * clientID per ADR 0008).
     *
     * Self-progressing without an explicit cursor: each successful
     * cascade-archive sets the child's `time_deleted` and
     * `cascade_source`, removing it from the next batch's SELECT.
     * A failed cascade leaves the child visible to the next tick,
     * which re-tries on the next alarm — at-least-once delivery.
     *
     * State-driven mid-sweep restore (ADR 0008 §"Restore"): if the
     * workspace's own `time_deleted` is null when the handler fires
     * (a `restoreWorkspace` raced in between the user's Delete and
     * this tick), the sweep aborts. 10a.5 turns that abort into the
     * inverse sweep.
     *
     * Re-arms itself for "immediate" (`Date.now()`) when a batch was
     * non-empty, so subsequent ticks continue draining. Cancels the
     * event when the catalog query returns empty — the campaign is
     * either complete or the workspace was restored.
     */
    static readonly CASCADE_ARCHIVE_BATCH_SIZE = 10;

    async handleCascadeArchive(): Promise<void> {
        const entityId = getEntityId(this.sql);
        if (!entityId || !entityId.startsWith('w/')) {
            // Not a workspace DO. Should never reach the handler given
            // the trigger guard in `_handlePush`, but a misconfigured
            // event key shouldn't loop forever.
            console.warn(
                `\`handleCascadeArchive()\` not a workspace entity (id="${entityId}"); canceling`
            );
            await this.cancelEvent('cascade-archive');
            return;
        }

        // Read this workspace's own time_deleted to use as the
        // deletion-timestamp portion of the synthetic clientID. Also
        // doubles as the abort check: if the user restored the
        // workspace before this tick, time_deleted is null and we
        // bail (10a.5 turns this into the inverse sweep).
        const own = this.sql
            .exec(
                `SELECT time_deleted FROM list_elements WHERE id = ?;`,
                entityId
            )
            .one();
        const ownTimeDeletedRaw = own?.time_deleted as number | null;
        if (ownTimeDeletedRaw == null) {
            console.log(
                `\`handleCascadeArchive()\` workspace "${entityId}" not deleted; canceling`
            );
            await this.cancelEvent('cascade-archive');
            return;
        }
        // time_deleted is unix seconds in the DO row (`getElementById`
        // multiplies by 1000); raw column read is seconds. Convert to
        // ms for the clientID — keeps the cascade campaign id stable
        // across restarts even though the wall clock has moved.
        const deletionTsMs = ownTimeDeletedRaw * 1000;

        const d1 = (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH;
        const batchResult = await d1
            .prepare(
                `SELECT id FROM workspace_entities
                 WHERE workspace_id = ?
                   AND time_deleted IS NULL
                   AND cascade_source IS NULL
                 ORDER BY id
                 LIMIT ?`
            )
            .bind(entityId, DjibbList.CASCADE_ARCHIVE_BATCH_SIZE)
            .all<{ id: string }>();

        const rows = batchResult.results ?? [];
        if (rows.length === 0) {
            // Drained. Per ADR 0008 the next workspace-side event is
            // the 30d hard-delete clock (10b); we don't set it here
            // because the trigger landed it at archive time. Just
            // clear the cascade-archive key.
            await this.cancelEvent('cascade-archive');
            return;
        }

        for (const { id: childId } of rows) {
            try {
                await this.cascadeArchiveChild(
                    childId,
                    entityId,
                    deletionTsMs
                );
            } catch (error) {
                console.error(
                    `\`handleCascadeArchive()\` child push failed for "${childId}":`,
                    error
                );
                // Leave the child unarchived; next batch re-selects it
                // (its time_deleted didn't get set). Retries are
                // bounded by progress on the rest of the batch.
            }
        }

        // Re-arm for "immediate" — the dispatcher will run us again
        // when Cloudflare's alarm fires next. A batch < N children
        // doesn't mean we're done (a write could have raced); keep
        // looping until the SELECT comes back empty.
        await this.scheduleEvent('cascade-archive', Date.now());
    }

    /**
     * Cascade-archive a single child entity (List or Template) via
     * a synthetic-client push to its DO. ADR 0008 §"Cascade-archive
     * invocation":
     *
     *   - clientID = `cascade:<workspaceId>:<deletionTimestampMs>`
     *     — campaign-scoped; a fresh deletion mints a fresh clientID,
     *     so delete→restore→delete cycles never reuse one.
     *   - mutationId = 1 — child DOs each maintain their own
     *     `replicache_clients` table, so this clientID is new to every
     *     child the first time we push to it; mutationId=1 works
     *     uniformly across all children of one campaign. Retries on
     *     the same child are idempotent: Replicache recognizes
     *     mutationId=1 as already-processed and no-ops.
     *   - authorizedRole = 'system' — gates on the cascade mutator's
     *     SYSTEM_ROLES requiredRole (ADR 0011 §Step 10a.3).
     */
    private async cascadeArchiveChild(
        childId: string,
        workspaceId: string,
        deletionTsMs: number
    ): Promise<void> {
        const env = this.env as { DJIBB_LIST: DurableObjectNamespace };
        const stubId = env.DJIBB_LIST.idFromName(childId);
        const stub = env.DJIBB_LIST.get(
            stubId
        ) as unknown as DurableObjectStub<DjibbList>;
        const clientID = `cascade:${workspaceId}:${deletionTsMs}`;

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'system',
            listId: childId,
            pushRequest: {
                profileID: 'p_cascade',
                clientGroupID: `cg_cascade:${workspaceId}`,
                pushVersion: 1,
                schemaVersion: '1',
                mutations: [
                    {
                        clientID,
                        id: 1,
                        name: 'cascadeArchiveList',
                        timestamp: Date.now(),
                        args: {
                            accountId: null,
                            timestamp_client: new Date().toISOString(),
                            listId: childId,
                            cascade_source: workspaceId,
                        },
                    },
                ],
            },
        });
    }

    /**
     * Workspace cascade-restore sweep (ADR 0008, ADR 0011 §Step 10a.5).
     *
     * Mirror of `handleCascadeArchive`. Drains children whose
     * `cascade_source` matches this workspace's id and whose
     * `time_deleted` is still set — i.e. the ones this specific
     * deletion-then-restore campaign needs to flip back.
     *
     * Skip semantics (preserved from the archive side, by SQL design):
     *
     *   - `cascade_source IS NULL` (user-archived before the workspace
     *     was deleted) → excluded from the batch. The user's prior
     *     intent — "this list belongs in the trash" — survives the
     *     workspace round-trip.
     *   - `cascade_source != self` (cascaded under a different
     *     workspace) → excluded. Each workspace restores only what
     *     it archived.
     *   - `time_deleted IS NULL` (already restored or never archived)
     *     → excluded. Idempotent against partial-restore retries.
     *
     * Mid-restore re-archive: the handler reads the workspace's own
     * `time_deleted` first. If non-null (a fresh `archiveList` raced
     * ahead of this tick), the sweep cancels; the `_handlePush`
     * trigger has already re-enqueued cascade-archive for the
     * resumption.
     *
     * Cursorless, like the archive side: each successful restore
     * clears the child's `cascade_source`, dropping it from the next
     * batch's SELECT. Re-arms on any non-empty batch; cancels on
     * empty.
     */
    async handleCascadeRestore(): Promise<void> {
        const entityId = getEntityId(this.sql);
        if (!entityId || !entityId.startsWith('w/')) {
            console.warn(
                `\`handleCascadeRestore()\` not a workspace entity (id="${entityId}"); canceling`
            );
            await this.cancelEvent('cascade-restore');
            return;
        }

        const own = this.sql
            .exec(
                `SELECT time_deleted, time_updated FROM list_elements WHERE id = ?;`,
                entityId
            )
            .one();
        const ownTimeDeleted = own?.time_deleted as number | null;
        if (ownTimeDeleted != null) {
            // Workspace got re-archived between the user's restore and
            // this alarm tick. The archive trigger has already
            // enqueued cascade-archive; cancel restore to avoid
            // chasing the older direction.
            console.log(
                `\`handleCascadeRestore()\` workspace "${entityId}" re-archived; canceling restore`
            );
            await this.cancelEvent('cascade-restore');
            return;
        }
        // The workspace's `time_updated` was bumped by the
        // unarchiveList that triggered this sweep, so it's a monotonic
        // per-campaign timestamp — same epoch role the deletion
        // timestamp plays for cascade-archive. Without it, a
        // delete→restore→delete→restore cycle would re-use the same
        // clientID across the two restore campaigns; Replicache's
        // per-(DO, clientID) mutationID counter would then skip the
        // second restore's push as already-processed.
        const restoreTsMs = (own.time_updated as number) * 1000;

        const d1 = (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH;
        const batchResult = await d1
            .prepare(
                `SELECT id FROM workspace_entities
                 WHERE workspace_id = ?
                   AND cascade_source = ?
                   AND time_deleted IS NOT NULL
                 ORDER BY id
                 LIMIT ?`
            )
            .bind(entityId, entityId, DjibbList.CASCADE_ARCHIVE_BATCH_SIZE)
            .all<{ id: string }>();

        const rows = batchResult.results ?? [];
        if (rows.length === 0) {
            await this.cancelEvent('cascade-restore');
            return;
        }

        for (const { id: childId } of rows) {
            try {
                await this.cascadeRestoreChild(
                    childId,
                    entityId,
                    restoreTsMs
                );
            } catch (error) {
                console.error(
                    `\`handleCascadeRestore()\` child push failed for "${childId}":`,
                    error
                );
            }
        }

        await this.scheduleEvent('cascade-restore', Date.now());
    }

    /**
     * Cascade-restore a single child entity via synthetic-client push.
     * Symmetric with `cascadeArchiveChild`: clientID encodes the
     * campaign epoch (here, the workspace's `time_updated` from when
     * the unarchive ran), so delete→restore→delete→restore cycles
     * never reuse a clientID. Without this, the second restore's
     * mutationId=1 push would be rejected by Replicache as
     * already-processed against the first restore's clientID, and the
     * second restore would silently no-op.
     */
    private async cascadeRestoreChild(
        childId: string,
        workspaceId: string,
        restoreTsMs: number
    ): Promise<void> {
        const env = this.env as { DJIBB_LIST: DurableObjectNamespace };
        const stubId = env.DJIBB_LIST.idFromName(childId);
        const stub = env.DJIBB_LIST.get(
            stubId
        ) as unknown as DurableObjectStub<DjibbList>;
        const clientID = `cascade-restore:${workspaceId}:${restoreTsMs}`;

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'system',
            listId: childId,
            pushRequest: {
                profileID: 'p_cascade',
                clientGroupID: `cg_cascade:${workspaceId}`,
                pushVersion: 1,
                schemaVersion: '1',
                mutations: [
                    {
                        clientID,
                        id: 1,
                        name: 'cascadeRestoreList',
                        timestamp: Date.now(),
                        args: {
                            accountId: null,
                            timestamp_client: new Date().toISOString(),
                            listId: childId,
                            cascade_source: workspaceId,
                        },
                    },
                ],
            },
        });
    }

    async handleReconcile(): Promise<void> {
        const entityId = getEntityId(this.sql);
        if (!entityId) {
            console.warn(
                '`handleReconcile()` no entity row; re-arming at healthy'
            );
            await this.scheduleEvent(
                'reconcile',
                Date.now() + DjibbList.RECONCILE_HEALTHY_MS
            );
            return;
        }

        const entity = getElementById(this.sql, entityId);
        const doVersion =
            entity && isEntityRowType(entity.type)
                ? entity.version
                : null;

        let nextDelayMs = DjibbList.RECONCILE_HEALTHY_MS;
        try {
            const d1Version = await GetEntityVersion(
                (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH,
                entityId
            );

            // ADR 0011 §Step 7: also check the memberships projection
            // for drift. The entity row + memberships are emitted as
            // two sequential D1 writes from `emitEntitySnapshot()`; if
            // the first succeeds and the second fails, versions match
            // but memberships are stale and the steady-state skip
            // below would miss it. Count-only check — same shape as
            // the version check, cheap enough to run every alarm.
            const expectedMembershipCount = entity && isEntityRow(entity)
                ? Object.keys(
                      entity.authorization_rules.authorized_accounts
                  ).length
                : 0;
            const d1MembershipCount = await this.countD1Memberships(entityId);
            const membershipsDrifted =
                d1MembershipCount !== expectedMembershipCount;

            if (
                d1Version !== null &&
                d1Version === doVersion &&
                !membershipsDrifted
            ) {
                // Steady state — D1 already mirrors the DO. The
                // skip path is the 99% case and what makes the
                // alarm budget cheap. ADR 0007.
                console.log(
                    `\`handleReconcile()\` no drift (v=${doVersion}); skipping emit`
                );
            } else {
                console.log(
                    `\`handleReconcile()\` drift: do=${doVersion} d1=${d1Version}; emitting`
                );
                await this.emitEntitySnapshot(entityId);
                // emitEntitySnapshot throws on D1 failure; the throw
                // propagates to the outer catch below, which records
                // the retry interval and re-arms at backoff. A
                // persistent emit failure now drives the retry loop
                // instead of silently waiting 24h for the next pass.
            }

            await this.ctx.storage.delete(DjibbList.RECONCILE_RETRY_KEY);
        } catch (error) {
            console.error('`handleReconcile()` threw:', error);
            // First failure: store the initial interval. Subsequent
            // consecutive failures: double the previous, capped at
            // the healthy cadence. Matches ADR 0007's "starting at
            // 5 minutes" phrasing.
            const prev = await this.ctx.storage.get<number>(
                DjibbList.RECONCILE_RETRY_KEY
            );
            nextDelayMs =
                prev === undefined
                    ? DjibbList.RECONCILE_RETRY_INITIAL_MS
                    : Math.min(prev * 2, DjibbList.RECONCILE_HEALTHY_MS);
            await this.ctx.storage.put(
                DjibbList.RECONCILE_RETRY_KEY,
                nextDelayMs
            );
        }

        await this.scheduleEvent('reconcile', Date.now() + nextDelayMs);
    }

    /**
     * Pokes each open websocket client with a typed `{type:'poke'}`
     * message to indicate their Replicache should Pull. Wire format
     * migrated to JSON in B.1 (ADR 0006); the previous plain-string
     * `'pull pls'` payload is gone.
     */
    poke() {
        const websockets = this.ctx.getWebSockets();
        console.log('`poke()` running! Websocket count:', websockets.length);

        const payload = encodeWSMessage({ type: 'poke' });
        for (const ws of websockets) {
            if (ws.readyState === WS_STATE.OPEN) {
                ws.send(payload);
            }
        }
    }

    /**
     * Unicast a per-mutation outcome to the originating client over
     * the websocket(s) tagged with its clientID at accept time
     * (ADR 0006). Silent-drop if the client connected without a tag —
     * supports graceful deploy across the wire-format migration. Only
     * called for failure outcomes; success is implicit per ADR 0005.
     *
     * `reason` / `message` are optional structured + human-readable
     * extras attached by preflight-driven failures (ADR 0009 Slice 3
     * redo). The legacy outcome callers (CAS-stale / target-gone /
     * role-gate inside the mutator) omit them.
     */
    private emitMutationOutcome(
        clientID: string,
        mutationID: number,
        status: MutationOutcomeStatus,
        extras?: { reason?: string; message?: string }
    ): void {
        const targets = this.ctx.getWebSockets(clientID);
        if (targets.length === 0) return;

        const payload: WSMessage = {
            type: 'mutation_outcome',
            mutationID,
            status,
            ...(extras?.reason !== undefined && { reason: extras.reason }),
            ...(extras?.message !== undefined && { message: extras.message }),
        };
        const encoded = encodeWSMessage(payload);
        for (const ws of targets) {
            if (ws.readyState === WS_STATE.OPEN) {
                ws.send(encoded);
            }
        }
    }

    /**
     * Wrangler invokes `webSocketClose` if the client closes the
     * connection.
     */
    async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean
    ) {
        console.log('`webSocketClose()` running!', { code, reason, wasClean });

        ws.close(code, 'Durable Object is closing WebSocket');
    }

    webSocketError(ws: WebSocket, error: any) {
        console.error('`webSocketError()` running! error:', error);
    }

    // private withErrorHandling<T>(fn: () => T) {
    //     try {
    //         // const result = fn();
    //         // return new Response(JSON.stringify(result), {
    //         //     status: 200,
    //         //     headers: { 'Content-Type': 'application/json' },
    //         // });
    //         return fn();
    //     } catch (error) {
    //         return ErrorToResponse(error);
    //     }
    // }
}
