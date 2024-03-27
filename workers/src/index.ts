// import { parse, serialize } from 'cookie';

// import { DjibbAuth } from './auth/fetch';
import { DjibbList } from './list/fetch';
import { URL_SEGMENT_LIST_ID } from './list/constants';
// import {
// 	COOKIE_NAME_SESSION_ID,
// 	DURABLE_OBJECT_NAME_AUTH,
// } from './auth/constants';
import { handleOptions } from './utils/fetch';

/**
 * Associate bindings declared in wrangler.toml with TypeScript types.
 */
export interface Env {
	// Bindings for Durable Objects.
	// DJIBB_AUTH: DurableObjectNamespace;
	DJIBB_LIST: DurableObjectNamespace;
	KV_AUTH: KVNamespace;
}

// We still have to export the Durable Object class from `index.ts`.
export { DjibbList };

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		// const request = await this.handleSession(originalRequest, env);

		return this.handleFetch(request, env, ctx).catch((error) => {
			console.error('top-level error:', JSON.stringify(error));
			return new Response(null, { status: 500 });
		});
	},

	/**
	 * Gets a stub for the Djibb Auth Durable Object, which can be used
	 * elsewhere to handle Auth-related stuff for requests.
	 *
	 * I'm not sure I've made the right infrastructure choices here.
	 * The idea is to have a single instance of the auth stuff to help
	 * ensure timing of i/o is centralized and prevents race conditions
	 * and stuff. Thus, use a Durable Object.
	 */
	// getAuthStub(env: Env) {
	// 	const id: DurableObjectId = env.DJIBB_AUTH.idFromName(
	// 		DURABLE_OBJECT_NAME_AUTH
	// 	);

	// 	// This stub creates a communication channel with the Durable
	// 	// Object instance. The Durable Object constructor will be
	// 	// invoked upon the first call for a given id.
	// 	return env.DJIBB_AUTH.get(id);
	// },

	async handleFetch(request: Request, env: Env, ctx: ExecutionContext) {
		// const request = await this.handleSession(originalRequest, env);

		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		// Reusable URL interface to do simple checks for routing.
		// Not ideal to do shit all willy nilly like this, but the plan
		// is to either move all this API stuff back into the SvelteKit
		// repo, or to make this a separate repo running Hono framework.
		const requestURL = new URL(request.url);

		if (requestURL.pathname === '/auth') {
			const stub = this.getAuthStub(env);

			// Call `fetch()` on the stub to send a request to the Durable
			// Object instance. The Durable Object instance will invoke its
			// fetch handler to handle the request.
			let response = await stub.fetch(request);

			return response;
		}

		const urlGroups = DjibbList.parseURL(request.url);

		if (!urlGroups || !urlGroups.groups?.[URL_SEGMENT_LIST_ID]) {
			console.log('NOT FOUND:', request.url);

			return new Response(null, { status: 404 });
		}

		// Create a `DurableObjectId` using the List ID from the parsed
		// URL. The ID refers to a unique instance of the `DjibbList`
		// class in this file.
		const id: DurableObjectId = env.DJIBB_LIST.idFromName(
			urlGroups.groups[URL_SEGMENT_LIST_ID]
		);

		// This stub creates a communication channel with the Durable
		// Object instance. The Durable Object constructor will be
		// invoked upon the first call for a given id.
		const stub: DurableObjectStub = env.DJIBB_LIST.get(id);

		// Call `fetch()` on the stub to send a request to the Durable
		// Object instance. The Durable Object instance will invoke its
		// fetch handler to handle the request.
		const response = await stub.fetch(request);

		return response;
	},

	// async handleSession(request: Request, env: Env): Promise<Request> {
	// 	// const clonedHeaders = request.headers.
	// 	const header = request.headers.get('cookie') ?? '';

	// 	const cookies = parse(header);

	// 	console.log('cookies:', cookies);

	// 	if (!cookies[COOKIE_NAME_SESSION_ID]) {
	// 		console.log('no session id! requesting a fresh one');

	// 		// Create a Session ID here.
	// 		// const clonedRequest = new Request(request);
	// 		// clonedRequest.headers = new Headers()
	// 		const stub = this.getAuthStub(env);

	// 		const response = await stub.fetch(
	// 			// Create a new request that points to the route the
	// 			// Auth Durable Object will listen at for Session IDs.
	// 			// Pass along the headers – because why not. Update
	// 			// this as needed to auth shit appropriately.
	// 			new Request('/new-session', { headers: request.headers })
	// 		);

	// 		if (response.ok) {
	// 			const headers = new Headers(request.headers);
	// 			const responseSetCookie = response.headers.get('set-cookie');

	// 			const serializedCookie = serialize(
	// 				COOKIE_NAME_SESSION_ID,
	// 				responseSetCookie
	// 			);

	// 			headers.append('cookie', serializedCookie);

	// 			// Set the `Set-Cookie` on the request. We check for
	// 			// that header before returning the true response and
	// 			// append it as a header to the response then because
	// 			// we don't have the response yet.
	// 			headers.append('Set-Cookie', serializedCookie);

	// 			return new Request(request, { headers });
	// 		}
	// 	}

	// 	return request;
	// },
};
