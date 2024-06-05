import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Register, RegisteredDatabaseSessionAttributes, User } from 'lucia';
import { PullResponseOKV1, PushRequestV1 } from 'replicache';
import { z } from 'zod';

import { Env } from '..';
import { REF_LIST, REF_LIST_AUTH_RULES } from './constants';
import { List, ListElement } from './index';
import {
    ReplicacheClientGroup,
    TransactionalStorageToRepTx,
    clientGroupKey,
} from '../replicache';
import { mutators } from './mutators';
import { handle_session } from '../auth/middleware';
import {
    AuthorizationRole,
    AuthorizationRoleEnum,
    AuthorizationRules,
    GeneralRoleEnum,
    RulesSetByEnum,
} from '../auth/rules';
import { WS_MESSAGE_PULL_PLS, WS_STATE } from '../websocket/constants';

import { init } from './init_data';
import {
    DjibbError,
    ParseError,
    UnexpectedError,
    ValidationError,
} from '../errors';
import { UnauthorizedError } from '../auth/errors';
import { InvalidMutatorError } from '../replicache/errors';

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
interface list_context {
    Bindings: Env;
    Variables: {
        authorized_role: AuthorizationRole;
        lucia: Register['Lucia'];
        session: RegisteredDatabaseSessionAttributes | null;
        stub: DurableObjectStub<DjibbList>;
        user: User | null;
    };
}

/**
 * This is the sub-router to handle List-related requests by invoking
 * the Durable Object for the request's List ID.
 * @see https://hono.dev/api/routing#grouping
 */
export const list_app = new Hono<list_context>();

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

    // Create a `DurableObjectId` using the List ID query param.
    // The ID refers to a unique instance of the `DjibbList`
    // class in this file.
    const durable_object_id: DurableObjectId =
        c.env.DJIBB_LIST.idFromName(query_param_list_id);

    // This stub creates a communication channel with the Durable
    // Object instance. The Durable Object constructor will be
    // invoked upon the first call for a given id.
    const stub = c.env.DJIBB_LIST.get(
        durable_object_id
    ) as DurableObjectStub<DjibbList>;

    if (!stub) {
        console.error('no DJIBB_LIST stub!');
        throw new UnexpectedError();
    }

    c.set('stub', stub);

    await next();
});

// Authentication middleware to pull session data tied to the requests'
// cookie, if any.
list_app.use('*', handle_session);

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
    const authorizationRules = await c.get('stub').getAuthorizationRules();

    // Eval rules.
    let authRole: AuthorizationRole | undefined;

    // First, check the session's authorized accounts against the
    // List's authed accounts.
    for (const authedAccount of c.get('session')?.account_ids || []) {
        if (authorizationRules.authorized_accounts[authedAccount]) {
            // If we already have a match, then we've hit unhandled
            // territory.
            if (authRole) {
                /**
                 * @UNHANDLED:
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
                    'ERR: auth/multiple-authed-accounts: multiple authed accounts for the same list'
                );
                throw new UnexpectedError();
            }

            authRole =
                authorizationRules.authorized_accounts[authedAccount].role;
        }
    }

    /**
     * @UNHANDLED: check for membership in the List's Workspace.
     * If membership confirmed, assign Workspace role, if any.
     */
    // if (!authRole) {
    //     // check for Workspace role here
    // }

    if (!authRole) {
        // Not an authorized user. Use generic role.
        authRole = authorizationRules.general_role;
    }

    c.set('authorized_role', authRole);

    return next();
});

/**
 * Request body for a Replicache Pull Request.
 *
 * I don't really have a good place to put this... Move if you want.
 */
const ReplicachePullRequestSchema = z.object({
    pullVersion: z.literal(1),
    profileID: z.string(),
    clientGroupID: z.string(),
    cookie: z.union([z.number(), z.null()]),
    schemaVersion: z.string(),
});

type ReplicachePullRequest = z.TypeOf<typeof ReplicachePullRequestSchema>;

list_app.post('/pull', async c => {
    const json = await c.req.json().catch(() => {
        throw new ParseError();
    });

    const parse_result = ReplicachePullRequestSchema.safeParse(json);

    if (!parse_result.success) {
        throw new ValidationError('invalid JSON value(s)');
    }

    const pullResponse = await c.get('stub').handlePull({
        authorizedRole: c.get('authorized_role'),
        pullRequest: parse_result.data,
    });

    return c.json(pullResponse);
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
        throw new UnauthorizedError();
    }

    await c.get('stub').handlePush({
        authorizedRole: c.get('authorized_role'),
        pushRequest,
    });

    // Replicache ignores any response body to the `push` endpoint, so
    // we don't have anything to return. If the handler didn't throw,
    // we're good.
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
    return c.get('stub').fetch(c.req.raw);
});

list_app.onError(err => {
    if (err instanceof DjibbError) {
        return new Response(
            JSON.stringify({
                code: err.code,
                error: err.name,
                message: err.message,
            }),
            { status: err.httpStatusCode }
        );
    } else if (err instanceof HTTPException) {
        // Keep throwing. Hono will handle.
        throw err;
    }

    // Unhandled err.
    console.error('`list_app.onError()` unhandled err:', err);

    throw new HTTPException(500);
});

export class DjibbList extends DurableObject {
    static defaultAuthorizationRules: AuthorizationRules = {
        authorized_accounts: {},
        general_role: GeneralRoleEnum.Enum.ownerless,
        set_by: RulesSetByEnum.Enum.defaults,
    };

    async getAuthorizationRules(): Promise<AuthorizationRules> {
        let rules =
            await this.ctx.storage.get<AuthorizationRules>(REF_LIST_AUTH_RULES);

        if (!rules) {
            rules = DjibbList.defaultAuthorizationRules;
        }

        return rules;
    }

    /**
     * Pulls the record for the given `elementRef` from storage, then
     * walks the tree for its children – recursively working through any
     * of its children – to collect all elements that have a version
     * greater than the given `version` and storing them in the given
     * `accumulator`.
     */
    async getElementsByVersion(
        accumulator: any[],
        version: number,
        elementRef: string
    ) {
        if (elementRef === undefined || 0 > version) {
            console.log('abandon ship!');
            return;
        }

        const element = (await this.ctx.storage.get(elementRef)) as ListElement;

        if (!element) {
            if (elementRef === REF_LIST) {
                // Initialize the list.
                // @TODO: remove this once we have list-creation
                // implemented.
                await init(this.ctx.storage);
            }

            console.warn(
                `\`getElementsByVersion()\` error: element not found for ref "${elementRef}".`
            );

            return;
        }

        if (element.version > version) {
            accumulator.push(element);
        }

        // If the element has been deleted, we can stop here.
        // We're walking a tree, so we don't need to "find" any deleted
        // children.
        //
        // Not sure how to handle a deleted list...
        if (element.time_deleted) return;

        const arrPromises = [];

        // TypeScript only detects the "control flow" here if you use
        // the string value, not the `LIST_ELEMENT_TYPES` const.
        if (element.type === 'item') return;

        for (const childElemRef of element.child_element_refs) {
            if (!childElemRef) {
                console.log(
                    '`getElementsByVersion()` bad child ref:',
                    childElemRef
                );
                continue;
            }

            arrPromises.push(
                this.getElementsByVersion(accumulator, version, childElemRef)
            );
        }

        await Promise.all(arrPromises);
    }

    /**
     * Handles Pull requests by evaluating where the requesting client
     * stands (what data does it have?), and creating a patch of changes
     * to get it up to date with the Server's state.
     */
    public async handlePull({
        // authorizedRole,
        pullRequest,
    }: {
        authorizedRole: AuthorizationRole;
        pullRequest: ReplicachePullRequest;
    }): Promise<PullResponseOKV1> {
        const requestVersion = pullRequest.cookie ?? 0;

        const listElements: Array<ListElement> = [];

        await this.getElementsByVersion(listElements, requestVersion, REF_LIST);

        // Init our response with default property values.
        const pullResponse: PullResponseOKV1 = {
            cookie: -1, // Indicates bad version
            lastMutationIDChanges: {},
            patch: [],
        };

        // Look up the Client Group for the request's `clientGroupID` value.
        // Then, loop through the Group's Clients to pull the
        // `lastMutationID` for each.
        // Replicache needs that info to confirm which mutations have
        // been canonicalized on the server.
        const replicacheClientGroup = (await this.ctx.storage.get(
            clientGroupKey(pullRequest.clientGroupID)
        )) as ReplicacheClientGroup | undefined;

        if (!replicacheClientGroup) {
            console.log(
                `\`handlePull()\` ReplicacheClientGroup not found for ID "${pullRequest.clientGroupID}"`
            );
        } else {
            // Loop through the Clients in the ClientGroup. If a client's
            // `lastModifiedVersion` is greater than the `requestVersion`,
            // then we'll include that Client's last Mutation ID in the
            // Pull Response. That allows Replicache to know where that
            // client stands in comparison to the Server's authoritative
            // state.
            for (const [clientID, client] of replicacheClientGroup.clients) {
                if (client.lastModifiedVersion > requestVersion) {
                    pullResponse.lastMutationIDChanges[clientID] =
                        client.lastMutationID;
                }
            }
        }

        // Set the response's `cookie` value, which is the List's version.
        // Find the Version by looping through the List Elements, looking
        // for the List Itself. If not among the updated element, pull
        // the list directly.
        let foundListVersion = false;
        if (listElements.length > 0) {
            for (const element of listElements) {
                if (element.type === 'list') {
                    foundListVersion = true;
                    pullResponse.cookie = element.version;
                    break;
                }
            }
        }

        if (!foundListVersion) {
            // Pull the List Itself.
            const list = (await this.ctx.storage.get(REF_LIST)) as
                | List
                | undefined;

            if (list) {
                pullResponse.cookie = list.version;
            }
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
            const key = `${element.type}/${element.id}`;

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
                    value: element,
                });
            }
        }

        console.log(
            `Patch count to get from v${requestVersion} to v${pullResponse.cookie}:`,
            pullResponse.patch.length
        );

        return pullResponse;
    }

    /**
     * Handles a Push request from Replicache by evaluating each of
     * the request's mutations.
     */
    public async handlePush({
        authorizedRole,
        pushRequest,
    }: {
        authorizedRole: AuthorizationRole;
        pushRequest: PushRequestV1;
    }) {
        const list = (await this.ctx.storage.get(REF_LIST)) as List;
        const nextListVersion = list.version + 1;

        let replicacheClientGroup = (await this.ctx.storage.get(
            pushRequest.clientGroupID
        )) as ReplicacheClientGroup | undefined;

        if (!replicacheClientGroup) {
            console.log(
                `\`handlePush()\` no Client Group found for ID "${pushRequest.clientGroupID}"`
            );

            replicacheClientGroup = {
                clients: new Map(),
                id: pushRequest.clientGroupID,
            };
        }

        for (const mutation of pushRequest.mutations) {
            // Pull the ReplicacheClient for this mutation's Client ID.
            // Initialize it, if needed. We'll persist it later.
            let replicacheClient = replicacheClientGroup.clients.get(
                mutation.clientID
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
                    lastMutationID: 0,
                    lastModifiedVersion: 0,
                };
            }

            // Each mutation is created by a ReplicacheClient. We want
            // to ensure we process each mutation in order, just like
            // they happened on the frontend. Replicache helps us do
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
            const expectedMutationId = replicacheClient.lastMutationID + 1;

            // Check the Mutation's ID matches the Expected ID.
            if (expectedMutationId !== mutation.id) {
                console.log(
                    '`handlePush()` Mutation ID did not match expectations:',
                    {
                        clientID: mutation.clientID,
                        mutationID: mutation.id,
                        expectedMutationId: expectedMutationId,
                    }
                );

                if (expectedMutationId > mutation.id) {
                    // This mutation is from the past. We assume we've
                    // already handled it and skip.
                    console.log(
                        `Skipping mutation "${mutation.clientID}-${mutation.id}"!`
                    );
                    continue;
                }

                if (mutation.id > expectedMutationId) {
                    // This mutation is from the future! That's an error.
                    console.log(
                        `Aborting! "${mutation.clientID}-${mutation.id}"`
                    );
                    break;
                }
            }

            const mutator = (mutators as any)[mutation.name];

            if (!mutator) {
                console.error(
                    `\`handlePush()\` error: unknown mutator "${mutation.name}"`
                );

                throw new InvalidMutatorError(mutation.name);
            }

            // Start a transaction.
            // I *think* we can eventually do away with the
            // transaction, and instead map `ctx.storage` to
            // the Replicache transaction. But I like having
            // `rollback` method, at least for now.
            this.ctx.storage.transaction(async durableObjectTx => {
                try {
                    // Get the Replicache-adapted version of
                    // the transaction.
                    const tx = new TransactionalStorageToRepTx(
                        durableObjectTx,
                        nextListVersion
                    );

                    await mutator(tx, { args: mutation.args, authorizedRole });
                    console.log(
                        `mutator "${mutation.name}" ran!`,
                        mutation.args,
                        authorizedRole // @TODO: figure out how to pass this
                    );
                } catch (error) {
                    console.error(
                        `\`handleMutations()\` error executing mutator "${mutation.name}":`,
                        error
                    );

                    console.log('Rolling Back DO Transaction!!!');
                    durableObjectTx.rollback();

                    // TODO: do we throw an error here?
                }
            });
        }

        // Save the Replicache Client Group.
        this.ctx.storage.put(
            clientGroupKey(replicacheClientGroup.id),
            replicacheClientGroup
        );

        // Update and save the List Itself.
        this.ctx.storage.put(REF_LIST, {
            ...list,
            version: nextListVersion,
        });

        this.poke();

        // Replicache: the response body to the push endpoint is
        // ignored, so we return void.
        return;
    }

    public fetch(request: Request) {
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

        this.ctx.acceptWebSocket(server);

        return new Response(null, {
            headers: {
                'Sec-WebSocket-Accept': wsAcceptKey,
            },
            status: 101,
            webSocket: client,
        });
    }

    /**
     * Pokes each open websocket client with a message to indicate
     * their Replicache should Pull.
     */
    poke() {
        const websockets = this.ctx.getWebSockets();
        console.log('`poke()` running! Websocket count:', websockets.length);

        for (const ws of websockets) {
            if (ws.readyState === WS_STATE.OPEN) {
                ws.send(WS_MESSAGE_PULL_PLS);
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
}
