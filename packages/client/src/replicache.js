// @ts-check

/**
 * Framework-agnostic Replicache client wiring (ADR 0014). The transport
 * (credentialed pusher/puller) and entity→route mapping live here so
 * they're shared and testable without a Svelte runtime. The Svelte
 * shell in pages (`initList`, which uses `$state`) and the env-reading
 * client factory layer on top of these.
 */

import { Replicache } from 'replicache';
import { IdTypes } from '@djibb/protocol/id';
import { mutators } from '@djibb/protocol/list/mutators/client';

/**
 * Constructs the Replicache client for one (account, entity) pair. All
 * environment-specific values (license key, API host, http-vs-https)
 * are injected by the caller — this package never reads `import.meta`
 * or any framework env, so the app (pages) owns env access and this
 * stays a pure, framework-agnostic factory.
 *
 * @param {object} input
 * @param {string | null} input.accountId Account ID (`null` ⇒ anonymous)
 * @param {string} input.listId Entity ID; its prefix selects the route
 * @param {string} input.licenseKey Replicache license key
 * @param {string} input.baseUrl API host, no protocol (e.g. `api.djibb.com`)
 * @param {boolean} [input.secure=true] https when true; false for local dev
 *
 * The return type is intentionally left to inference: TypeScript reads
 * the concrete mutator generic off the `new Replicache({ mutators })`
 * call so callers see `client.mutate.<name>` for every registered
 * mutator. Annotating it as a bare `Replicache` would erase that
 * generic and collapse `.mutate` to an empty surface.
 */
export function createReplicacheClient({ accountId, listId, licenseKey, baseUrl, secure = true }) {
	if (!licenseKey) {
		throw new Error('Missing Replicache license key');
	}

	const protocol = secure ? 'https:' : 'http:';
	const path = entityPath(listId);
	const pullURL = `${protocol}//${baseUrl}/${path}/pull?l=${listId}`;
	const pushURL = `${protocol}//${baseUrl}/${path}/push?l=${listId}`;

	return new Replicache({
		licenseKey,
		mutators: mutators,
		// Template string to create something like `userId123:listId123`.
		// If no Account ID, it'll be `null:listId123`.
		name: `${accountId}:${listId}`,
		// Event-driven sync: poke via websocket triggers pulls; no polling.
		pullURL,
		pushURL,
		// Custom pusher/puller so the cross-origin push/pull sends the
		// session cookie. Replicache's default fetch omits credentials
		// and the worker would resolve the request as anonymous, which
		// trips auth on lists owned by an authed account.
		pusher: makePusher(pushURL),
		puller: makePuller(pullURL),
		// Bump when stored value shapes change; forces old clients to reset.
		schemaVersion: '1'
	});
}

/**
 * Maps an entity ID's type prefix to the worker-side router path that
 * serves it. The worker mounts `list_app` at `/list` and `template_app`
 * at `/template`; both share the same DO machinery but each enforces
 * its own ID prefix on incoming requests.
 *
 * @param {string} entityId
 * @returns {string}
 */
export function entityPath(entityId) {
	if (entityId.startsWith(`${IdTypes.template}/`)) return 'template';
	if (entityId.startsWith(`${IdTypes.workspace}/`)) return 'workspace';
	return 'list';
}

/**
 * @param {string} url
 * @returns {import('replicache').Pusher}
 */
export function makePusher(url) {
	return async (requestBody, requestID) => {
		const response = await fetch(url, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				'X-Replicache-RequestID': requestID
			},
			body: JSON.stringify(requestBody)
		});
		return {
			httpRequestInfo: {
				httpStatusCode: response.status,
				errorMessage: response.ok ? '' : await response.text()
			}
		};
	};
}

/**
 * @param {string} url
 * @returns {import('replicache').Puller}
 */
export function makePuller(url) {
	return async (requestBody, requestID) => {
		const response = await fetch(url, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				'X-Replicache-RequestID': requestID
			},
			body: JSON.stringify(requestBody)
		});
		const httpRequestInfo = {
			httpStatusCode: response.status,
			errorMessage: response.ok ? '' : await response.clone().text()
		};
		if (!response.ok) {
			return { httpRequestInfo };
		}
		return {
			httpRequestInfo,
			// `response.json()` widens to `any`; pin it to the V1 pull
			// shape so the returned object satisfies `PullerResultV1`
			// rather than being matched against the V0 branch (which
			// requires `lastMutationID`).
			response:
				/** @type {import('replicache').PullResponseV1} */ (
					await response.json()
				)
		};
	};
}
