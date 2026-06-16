// @ts-check

/**
 * Framework-agnostic Replicache client wiring (ADR 0014). The transport
 * (credentialed pusher/puller) and entity→route mapping live here so
 * they're shared and testable without a Svelte runtime. The Svelte
 * shell in pages (`initList`, which uses `$state`) and the env-reading
 * client factory layer on top of these.
 */

import { IdTypes } from '@djibb/protocol/id';

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
