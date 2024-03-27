import { serialize } from 'cookie';
import { nanoid } from 'nanoid';
import SimpleWebAuthnServer, {
	generateRegistrationOptions,
} from '@simplewebauthn/server';

import { Env } from '..';
import {
	COOKIE_NAME_SESSION_ID,
	RELYING_PARTY_ID,
	RELYING_PARTY_NAME,
} from './constants';
import { Authenticator, UserModel } from '.';
import { SESSION_ID_LENGTH, Session, sessionKey } from './session';

/** A Durable Object's behavior is defined in an exported Javascript class */
export class DjibbAuth {
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

		console.log('~~~ DjibbAuth Constructor running! ~~~');
	}

	/**
	 * The runtime invokes this `fetch` handler when a Worker sends this
	 * Durable Object a request via an associated stub.
	 *
	 * @param request - The request submitted to a Durable Object
	 * instance from a Worker
	 * @returns The response to be sent back to the Worker
	 */
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return this.handleFetch(request, env, ctx).catch((error) => {
			console.error('`DjibbAuth` top-level error:', JSON.stringify(error));
			return new Response(null, { status: 500 });
		});
	}

	async handleFetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/new-session') {
			return this.handleNewSession(request, env);
		}
		if (request.url.endsWith('passkey-options') && request.method === 'GET') {
			return this.handlePasskeyOptions(request);
		}

		return new Response(null, { status: 404 });
	}

	async handleNewSession(request: Request, env: Env) {
		// Prior to creating a new session, we could pause here to
		// check the request for an existing cookie and, if found,
		// invalidate it.

		// Create new Session ID.
		let sessionId = nanoid(SESSION_ID_LENGTH);

		const stored = await env.KV_AUTH.get(sessionKey(sessionId));
		console.log('sessionId:', sessionId, 'stored:', stored);

		if (stored) {
			console.log('key collision!', {
				newSessionId: sessionId,
				storedValue: stored,
			});

			// Try again.
			sessionId = nanoid(SESSION_ID_LENGTH);
			const newStored = await env.KV_AUTH.get(sessionKey(sessionId));

			if (stored) {
				console.log('SECOND collision!', {
					newSessionId: sessionId,
					storedValue: newStored,
				});

				return new Response(null, { status: 500 });
			}
		}

		// I don't know how to associate the Session ID with a User ID...
		const sessionValue: Session = { user_id: null };

		await env.KV_AUTH.put(sessionId, JSON.stringify(sessionValue));

		const headers = new Headers();
		headers.append('Set-Cookie', serialize(COOKIE_NAME_SESSION_ID, sessionId));

		return new Response(null, { headers, status: 204 });
	}

	/**
	 * Handles a request to generate options for the request's user
	 * (as determined by the request's Session ID) that the user's
	 * device can use to create a passkey for use with this server.
	 *
	 * The user must already be authenticated to generate the options.
	 * This fact is tricky for registering new users.
	 */
	async handlePasskeyOptions(request: Request) {
		// (Pseudocode) Get the user from the request's Session ID.
		// TODO: make this!
		// const user: UserModel = this.getSession(request);

		const user: UserModel = {
			id: 'i dunno',
			username: 'test_username',
		};

		// Retrieve any of the user's previously-registered
		// authenticators. We'll send existing authenticators as part
		// of the returned options so the authenticator will know it
		// should not re-register using existing ones.
		const userAuthenticators: Authenticator[] = []; // getUserAuthenticators(user);

		const options = await generateRegistrationOptions({
			rpName: RELYING_PARTY_NAME,
			rpID: RELYING_PARTY_ID,
			userID: user.id,
			userName: user.username,
			// Don't prompt users for additional information about the
			// authenticator (recommended for smoother UX).
			attestationType: 'none',
			// Prevent users from re-registering existing authenticators.
			excludeCredentials: userAuthenticators.map((authenticator) => ({
				id: authenticator.credentialID,
				type: 'public-key',
				// Optional
				transports: authenticator.transports,
			})),
			// See "Guiding use of authenticators via authenticatorSelection" below
			authenticatorSelection: {
				// Defaults
				residentKey: 'preferred',
				userVerification: 'preferred',
				// Optional
				authenticatorAttachment: 'platform',
			},
		});

		// Remember the challenge for this user. We'll reference it
		// when accepting the client's registration request to help
		// ensure the response is from the client we're sending this
		// response to an impersonator.
		// TODO: set this up
		// setUserCurrentChallenge(user, options.challenge);
		console.log('challenge:', options.challenge);
		options.user;

		return new Response(JSON.stringify(options));
	}

	/**
	 * Handles request from client to register with this server,
	 * verifying the request and shit.
	 */
	async handleRegistrationVerify() {}
}
