import { DurableObject } from 'cloudflare:workers';
import { MutationV1, PullResponseOKV1, PushRequestV1 } from 'replicache';

import { ReplicachePullRequest } from '../replicache';
import { List, ListElement } from './index';
import {
    executeServerMutation,
    MutationStatus,
    parseMutationEnvelope,
} from './mutators';

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
import { EmitEntitySnapshotToCatalog, GetEntityVersion } from './entity';
import {
    EmitInvitationsSnapshot,
    ensurePendingInvitesTable,
    listPendingInvites,
} from './invitations';
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
    'archiveList',
    'initFromTemplate',
    'initList',
    'renameList',
    'setDescription',
    'setListAuthRules',
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
    'inviteByIdentity',
    'revokeInvitation',
]);

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

        // Same DO machinery serves both lists and templates; accept
        // either entity type here.
        if (list?.type !== 'list' && list?.type !== 'template') {
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
        // @TODO: this is a very basic authorization check.
        // Please flesh out into legit checks, as needed.
        if (authorizedRole === 'restricted') {
            throw new UnauthorizedError();
        }

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
                if (element.type === 'list' || element.type === 'template') {
                    foundListVersion = true;
                    resolvedEntityVersion = element.version;
                    break;
                }
            }
        }

        if (!foundListVersion) {
            // Pull the entity itself (list or template — same machinery).
            const entity = getElementById(this.sql, listId);

            if (entity?.type !== 'list' && entity?.type !== 'template') {
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
        // Tracks whether any mutation in this push touched the DO's
        // `pending_invites` table. Triggers the post-commit
        // reconciliation emit to `entity_invitations_index` (ADR 0009).
        let invitationsMutated = false;

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
                if (INVITATION_MUTATORS.has(mutation.name)) {
                    invitationsMutated = true;
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
    private async emitEntitySnapshot(entityId: string): Promise<void> {
        const entity = getElementById(this.sql, entityId);
        if (!entity || (entity.type !== 'list' && entity.type !== 'template')) {
            console.warn(
                `\`emitEntitySnapshot()\` no entity row for "${entityId}"`
            );
            return;
        }

        await EmitEntitySnapshotToCatalog(
            (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH,
            {
                id: entity.id,
                workspace_id: entity.workspace_id,
                type: entity.type,
                name: entity.name,
                description: entity.description ?? null,
                forked_from_id: entity.forked_from_id,
                authorization_rules: entity.authorization_rules,
                time_created: Math.floor(
                    entity.time_created.getTime() / 1000
                ),
                time_updated: Math.floor(
                    entity.time_updated.getTime() / 1000
                ),
                time_deleted: entity.time_deleted
                    ? Math.floor(entity.time_deleted.getTime() / 1000)
                    : null,
                version: entity.version,
            }
        );
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
    private async emitInvitationsSnapshot(entityId: string): Promise<void> {
        const entity = getElementById(this.sql, entityId);
        if (!entity || (entity.type !== 'list' && entity.type !== 'template')) {
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

    /**
     * Schedule the first reconciliation alarm if one isn't already
     * set. Called at the tail of every successful push so a freshly-
     * created DO picks up the schedule on its first interaction; a
     * pre-existing DO that came up before ADR 0007 also picks it up
     * on its next push. Idempotent — `getAlarm()` returns the
     * scheduled time, not a count, so we only set when there's no
     * pending alarm.
     */
    private async ensureReconcileAlarm(): Promise<void> {
        const existing = await this.ctx.storage.getAlarm();
        if (existing !== null) return;
        await this.ctx.storage.setAlarm(
            Date.now() + DjibbList.RECONCILE_HEALTHY_MS
        );
    }

    /**
     * Reconciliation handler invoked by Cloudflare on the scheduled
     * alarm. Per ADR 0007:
     *
     *   1. Look up this DO's entity ID. If there isn't one, the DO
     *      was scheduled before it owned an entity (shouldn't
     *      happen, but defensive); skip and re-arm.
     *   2. Read D1's current version. If it matches the DO's,
     *      nothing to do — re-arm at the healthy cadence.
     *   3. Otherwise (drift or missing row) call the same
     *      `emitEntitySnapshot()` the push path uses. The version-
     *      guarded upsert handles concurrent writers.
     *   4. On success: clear retry state, re-arm at healthy.
     *      On failure: re-arm at the retry interval (exp backoff
     *      capped at healthy) so a transient outage doesn't stick.
     *
     * The alarm is the only writer of `RECONCILE_RETRY_KEY`. Push
     * handlers don't touch retry state — a fresh successful push
     * implicitly proves D1 is reachable, but we wait until the next
     * alarm to observe that rather than racing it.
     */
    async alarm(): Promise<void> {
        const entityId = getEntityId(this.sql);
        if (!entityId) {
            console.warn('`alarm()` no entity row; re-arming at healthy');
            await this.ctx.storage.setAlarm(
                Date.now() + DjibbList.RECONCILE_HEALTHY_MS
            );
            return;
        }

        const entity = getElementById(this.sql, entityId);
        const doVersion =
            entity && (entity.type === 'list' || entity.type === 'template')
                ? entity.version
                : null;

        let nextDelayMs = DjibbList.RECONCILE_HEALTHY_MS;
        try {
            const d1Version = await GetEntityVersion(
                (this.env as { DJIBB_AUTH: D1Database }).DJIBB_AUTH,
                entityId
            );

            if (d1Version !== null && d1Version === doVersion) {
                // Steady state — D1 already mirrors the DO. The
                // skip path is the 99% case and what makes the
                // alarm budget cheap. ADR 0007.
                console.log(
                    `\`alarm()\` no drift (v=${doVersion}); skipping emit`
                );
            } else {
                console.log(
                    `\`alarm()\` drift: do=${doVersion} d1=${d1Version}; emitting`
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
            console.error('`alarm()` reconciliation threw:', error);
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

        await this.ctx.storage.setAlarm(Date.now() + nextDelayMs);
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
     */
    private emitMutationOutcome(
        clientID: string,
        mutationID: number,
        status: MutationOutcomeStatus
    ): void {
        const targets = this.ctx.getWebSockets(clientID);
        if (targets.length === 0) return;

        const payload: WSMessage = {
            type: 'mutation_outcome',
            mutationID,
            status,
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
