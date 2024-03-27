import { PullResponseOKV1, PushRequestV1 } from 'replicache';
import { z } from 'zod';

import { Env } from '..';
import {
    LIST_ID_LENGTH,
    REF_LIST,
    URL_SEGMENT_ACTION,
    URL_SEGMENT_LIST_ID,
    URL_SEGMENT_SLUG,
} from './constants';
import { corsHeaders } from '../utils/fetch';
import { List, ListElement } from './index';
import {
    ReplicacheClientGroup,
    TransactionalStorageToRepTx,
    clientGroupKey,
} from '../replicache';
import { mutators } from './mutators';
import { WS_MESSAGE_PULL_PLS, WS_STATE } from '../websocket/constants';

const zPullRequest = z.object({
    pullVersion: z.literal(1),
    profileID: z.string(),
    clientGroupID: z.string(),
    cookie: z.union([z.number(), z.null()]),
    schemaVersion: z.string(),
});

/** A Durable Object's behavior is defined in an exported Javascript class */
export class DjibbList {
    // private ListId: string;
    private state: DurableObjectState;

    /**
     * The constructor is invoked once upon creation of the Durable
     * Object, i.e. the first call to `DurableObjectStub::get` for a
     * given identifier
     *
     * @param state - The interface for interacting with Durable Object state
     * @param env - The interface to reference bindings declared in wrangler.toml
     */
    constructor(state: DurableObjectState, env: Env) {
        this.state = state;

        console.log('~~~ DjibbList Constructor running! ~~~');
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

        const element = (await this.state.storage.get(
            elementRef
        )) as ListElement;

        if (!element) {
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

    fetch(request: Request) {
        return this.handleFetch(request).catch(error => {
            console.error(
                '`DjibbList` top-level error:',
                JSON.stringify(error)
            );
            return new Response(null, { status: 500 });
        });
    }

    /**
     * The runtime invokes this `fetch` handler when a Worker sends this
     * Durable Object a request via an associated stub.
     *
     * @param request - The request submitted to a Durable Object
     * instance from a Worker
     * @returns The response to be sent back to the Worker
     */
    async handleFetch(request: Request): Promise<Response> {
        const urlGroups = DjibbList.parseURL(request.url);

        // Not sure this is the most complete of conditions to trigger
        // the websocket handler, but...
        // if (request.url.endsWith('/websocket')) {
        if (urlGroups?.groups[URL_SEGMENT_ACTION] == 'websocket') {
            return this.handleWebsocket(request);
        }
        if (
            request.method === 'POST' &&
            urlGroups?.groups[URL_SEGMENT_ACTION] == 'pull'
        ) {
            return this.handlePull(request);
        }
        if (
            request.method === 'POST' &&
            urlGroups?.groups[URL_SEGMENT_ACTION] == 'push'
        ) {
            return this.handlePush(request);
        }

        // Should probably update the "final case" here to be an error
        // some kind because we don't have anything to handle their
        // request (could be unknown URL or bad method or whatever).
        return new Response(`Bad request, probably.`, { status: 400 });
    }

    /**
     * Handles mutations from a Push request.
     * @param mutations
     */
    async handleMutations(requestBody: PushRequestV1): Promise<Response> {
        const list = (await this.state.storage.get(REF_LIST)) as List;
        const nextListVersion = list.version + 1;

        let repClientGroup = (await this.state.storage.get(
            clientGroupKey(requestBody.clientGroupID)
        )) as ReplicacheClientGroup | undefined;

        if (!repClientGroup) {
            console.log(
                `\`handleMutations()\` no Client Group found for ID "${requestBody.clientGroupID}"`
            );

            // TODO: ensure this Client Group is authed to be here
            // before initializing it.
            repClientGroup = {
                clients: new Map(),
                id: requestBody.clientGroupID,
            };
        }

        // TODO: Once we have some User Auth stuff, we can verify the
        // `repClientGroup` is authorized to operate on this List.

        for (const mutation of requestBody.mutations) {
            // Pull the ReplicacheClient for this mutation's Client ID.
            // Initialize it, if needed.
            let repClient = repClientGroup.clients.get(mutation.clientID);

            if (!repClient) {
                console.log(
                    `\`handleMutations()\` ReplicacheClient not found for "${mutation.clientID}". Initializing! (btw, mutation.id is ${mutation.id}.)`
                );

                repClient = {
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
            // just that by assigning each Mutation a Mutation ID on
            // the frontend. It's just a number that is incremented for
            // each Mutation, just like an auto-increment column in SQL.
            //
            // On the backend, we track the last Mutation ID each
            // ReplicacheClient we've processed. That way, we can check
            // that each Mutation we're about to process is the right
            // one, and not one out of order. Move in sync!
            //
            // Calculate the expected Mutation ID for this Client by
            // simply adding 1 to the last known ID.
            const expectedMutationId = repClient.lastMutationID + 1;

            // Check that the Mutation ID matches the Expected ID.
            if (expectedMutationId !== mutation.id) {
                console.log(
                    '`handleMutations()` Mutation ID did not match expectations:',
                    {
                        clientID: mutation.clientID,
                        mutationID: mutation.id,
                        expectedMutationId,
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
                    `\`handleMutations()\` error: unknown mutator "${mutation.name}"`
                );
            } else {
                // Start a transaction.
                // I *think* we can eventually do away with the
                // transaction, and instead map `state.storage` to
                // the Replicache transaction. But I like having
                // `rollback` method, at least for now.
                this.state.storage.transaction(async txDO => {
                    try {
                        // Get the Replicache-adapted version of
                        // the transaction.
                        const tx = new TransactionalStorageToRepTx(
                            txDO,
                            nextListVersion
                        );

                        // console.log(
                        // 	'testing TESTING',
                        // 	tx.set('test', 'TEST VALUE'),
                        // 	await tx.get('test')
                        // );

                        console.log('mutator:', mutator);

                        await mutator(tx, mutation.args);
                        console.log(
                            `mutator "${mutation.name}" ran!`,
                            mutation.args
                        );
                    } catch (error) {
                        console.error(
                            `\`handleMutations()\` error executing mutator "${mutation.name}":`,
                            error
                        );
                        console.log('Rolling Back!');
                        txDO.rollback();
                    }
                });
            }

            // Set the ReplicacheClient, this time with updated values.
            repClientGroup.clients.set(mutation.clientID, {
                ...repClient,
                lastMutationID: expectedMutationId,
                lastModifiedVersion: nextListVersion,
            });
        }

        // Save the ReplicacheClientGroup.
        this.state.storage.put(
            clientGroupKey(repClientGroup.id),
            repClientGroup
        );

        // Update and save the List Itself.
        this.state.storage.put(REF_LIST, { ...list, version: nextListVersion });

        this.poke();

        return new Response(
            // Replicache: the response body to the push endpoint is ignored.
            null,
            {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
                status: 200,
            }
        );
    }

    /**
     * Handles Pull requests by evaluating where the requesting client
     * stands (what data does it have?), and creating a patch of changes
     * to get it up to date with the Server's state.
     */
    async handlePull(request: Request) {
        if (!request.body) {
            return new Response(`request must have a body`, {
                status: 400,
            });
        }

        // Detect bad JSON parsing by returning null.
        const json = await request.json().catch(() => null);

        if (json === null) {
            return new Response('JSON parse failure', {
                status: 400,
                statusText: 'Bad Request',
                headers: corsHeaders,
            });
        }

        const result = zPullRequest.safeParse(json);

        if (!result.success) {
            return new Response('Invalid JSON value(s)', {
                status: 400,
                statusText: 'Bad Request',
                headers: corsHeaders,
            });
        }

        const pullRequest = result.data;

        const requestVersion = pullRequest.cookie ?? 0;

        const listElements: Array<ListElement> = [];

        await this.getElementsByVersion(listElements, requestVersion, REF_LIST);

        const response: PullResponseOKV1 = {
            cookie: 0,
            lastMutationIDChanges: {},
            patch: [],
        };

        // Pull the `ReplicacheClientGroup` for this request, then loop
        // through its Clients to pull the `lastMutationID` for each.
        // Replicache needs that info to confirm which mutations have
        // been canonicalized on the server.
        const repClientGroup = (await this.state.storage.get(
            clientGroupKey(pullRequest.clientGroupID)
        )) as ReplicacheClientGroup | undefined;

        if (!repClientGroup) {
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
            for (const [clientID, client] of repClientGroup.clients) {
                if (client.lastModifiedVersion > requestVersion) {
                    response.lastMutationIDChanges[clientID] =
                        client.lastMutationID;
                }
            }
        }

        // Set the request's cookie, which is the List's Version.
        // Find the Version by looping through our List Elements, looking
        // for the List Itself. If not among the updated elements, pull
        // the list directly.
        let foundListVersion = false;
        if (listElements.length > 0) {
            for (const element of listElements) {
                if (element.type === 'list') {
                    // console.log(`Setting cookie to ${element.version}!`);
                    foundListVersion = true;
                    response.cookie = element.version;
                    console.log('element.version', element.version);
                    break;
                }
            }
        }

        if (!foundListVersion) {
            // Get the List Itself directly.
            const list = (await this.state.storage.get(REF_LIST)) as
                | List
                | undefined;

            if (list) {
                response.cookie = list.version;
                console.log('list.version', list.version);
            }
        }

        if (requestVersion === 0) {
            // Initialize a fresh client by clearing everything so we
            // start from scratch. (Not sure this is entirely necessary...)
            response.patch.push({
                op: 'clear',
            });
        }

        for (const element of listElements) {
            const key = `${element.type}/${element.id}`;

            if (element.time_deleted) {
                // Don't add this "del" operation to the list if we're
                // building a "from scratch" patch, because you only
                // need to delete things if you already have them.
                if (requestVersion === 0) continue;

                response.patch.push({
                    key,
                    op: 'del',
                });
            } else {
                response.patch.push({
                    key,
                    op: 'put',
                    value: element,
                });
            }
        }

        console.log(
            `Patch count to get from v${requestVersion} to v${response.cookie}:`,
            response.patch.length
        );

        return new Response(JSON.stringify(response), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    /**
     * Handles a Push request from Replicache by evaluating each of
     * the request's mutations.
     */
    async handlePush(request: Request) {
        if (!request.body) {
            return new Response(`request must have a body`, {
                status: 400,
            });
        }

        // Detect bad JSON parsing by returning null.
        const pushBody = (await request
            .json()
            .catch(() => null)) as PushRequestV1;

        if (pushBody === null) {
            return new Response('JSON parse failure', {
                status: 400,
                statusText: 'Bad Request',
                headers: corsHeaders,
            });
        }

        return this.handleMutations(pushBody);
    }

    /**
     * Handles requests for initiating a websocket connection.
     *
     * Calling `acceptWebSocket()` informs the runtime that this WebSocket
     * is to begin terminating request within the Durable Object. It has
     * the effect of "accepting" the connection, and allowing the
     * WebSocket to send and receive messages. Unlike `ws.accept()`,
     * `state.acceptWebSocket(ws)` informs the Workers Runtime that the
     * WebSocket is "hibernatable", so the runtime does not need to pin
     * this Durable Object to memory while the connection is open. During
     * periods of inactivity, the Durable Object can be evicted from
     * memory, but the WebSocket connection will remain open. If at some
     * later point the WebSocket receives a message, the runtime will
     * recreate the Durable Object (run the `constructor`) and deliver
     * the message to the appropriate handler.
     * @see https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
     */
    async handleWebsocket(request: Request) {
        // Expect to receive a WebSocket Upgrade request.
        // If there is one, accept the request and return a
        // WebSocket Response.
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response(
                'Expected request header `Upgrade: websocket`.',
                {
                    status: 426,
                }
            );
        }

        // Creates two ends of a WebSocket connection.
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        this.state.acceptWebSocket(server);

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    /**
	 * ON URLS
	 *
	 * I devised this shit with the idea that the frontend URL could
	 * have an optional slug in the path. I still like that idea,
	 * however it's a frontend problem/feature, and this is the
	 * backend.
	 *
	 * Consider removing the slug stuff.
	 *
	 * Consider using search params
	 * 		e.g. pushURL = `/api/replicache-push?spaceID=${spaceID}`
	 * See this example repo from Replicache:
	 * @see https://github.com/rocicorp/repliear/blob/main/pages/d/%5Bid%5D.tsx
	 * 
	 * Testing stuff:
	 * const tests = [
			'here-is-my-test-slug-HbqpIK7Naaf3OXRSE8s8j',
			'ts5V_Qj_Qa0CiYeu5d511/pull',
			'sWlenzH9X1mfzAnDXzQjP/push',
			'YKsuhktMpYUiLkeGbptOP',
		];

		const result = {};
		for (const test of tests) {
			result[test] = this.parseURL(`https://djibb.com/list/${test}`);
		}
	 */
    static parseURL(url: string) {
        const pattern = new URLPattern({
            pathname: `/list/{:${URL_SEGMENT_SLUG}}?:${URL_SEGMENT_LIST_ID}(\\w{${LIST_ID_LENGTH}})/:${URL_SEGMENT_ACTION}?`,
        });

        return pattern.exec(url)?.pathname;
    }

    /**
     * Pokes each open websocket client with a message to indicate
     * their Replicache should Pull.
     */
    poke() {
        const websockets = this.state.getWebSockets();
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

    /**
     * `webSocketMessage` is fired when the Websocket client sends a
     * message.
     */
    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
        // Respond to any incoming message with the same message
        // plus the prefix "[Durable Object]: ".
        ws.send(`[Durable Object]: ${message}`);
    }
}
