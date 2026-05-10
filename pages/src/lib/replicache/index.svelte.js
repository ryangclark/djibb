import { Replicache } from 'replicache';
import { dev } from '$app/environment';
import { mutators } from '$djibb/list/mutators/client';
import { IdTypes } from '$djibb/id';
import { createUndoRuntime } from './withUndo.svelte.js';

/**
 * Maps an entity ID's type prefix to the worker-side router path that
 * serves it. The worker mounts `list_app` at `/list` and `template_app`
 * at `/template`; both share the same DO machinery but each enforces
 * its own ID prefix on incoming requests.
 *
 * @param {string} entityId
 * @returns {string}
 */
function entityPath(entityId) {
	if (entityId.startsWith(`${IdTypes.template}/`)) return 'template';
	return 'list';
}

/**
 * Initializes the Replicache Client stuff.
 * This is mostly specific for a List instance.
 * We'll have to figure out how we might generalize stuff later.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 */
export function initList({ accountId, listId }) {
	/** @type {Object.<string, import('replicache').ReadonlyJSONValue>} */
	const listData = $state({});

	if (!listId) {
		throw new Error('Missing List Id!');
	}

	const replicacheClient = InitReplicacheClient({ accountId, listId });
	const mutate = wrapMutators(replicacheClient.mutate, { accountId });

	// Undo runtime layered on top of `mutate`. Both firing paths
	// (`mutate.foo` / `mutateWithUndo.foo`) flow through the same
	// envelope wrapper; only undo bookkeeping differs. Per ADR 0005.
	const undoRuntime = createUndoRuntime({
		client: replicacheClient,
		mutate,
		accountId,
		listId
	});

	/**
	 * Callback function to handle updates to the Replicache store by
	 * updating the data in the `listData` state rune.
	 *
	 * This is defined here to have `listData` in scope.
	 *
	 * @type {import('replicache').ExperimentalWatchNoIndexCallback}
	 */
	function replicacheExperimentalWatchCallback(diffs) {
		for (const diff of diffs) {
			if (diff.op === 'add' || diff.op === 'change') {
				listData[diff.key] = diff.newValue;
			} else {
				console.warn(
					'replicacheExperimentalWatchCallback unhandled diff.op:',
					diff
				);
			}
		}
	}

	// Watch for changes.
	replicacheClient.experimentalWatch(replicacheExperimentalWatchCallback, {
		initialValuesInFirstDiff: true
	});

	replicacheClient
		.query((tx) => tx.isEmpty())
		.then((isEmpty) => {
			if (isEmpty) {
				mutate.initList({
					listId,
					workspaceId: null // TODO: implement workspace
				});
			}
		});

	// Return the Svelte stuff we'll use to interact with
	// the Replicache client.
	return {
		client: replicacheClient,
		mutate,
		mutateWithUndo: undoRuntime.mutateWithUndo,
		undoRuntime,
		get list() {
			return listData;
		}
	};
}

/**
 * Wraps Replicache's raw `client.mutate` proxy so call sites pass BODY
 * args only — envelope fields (`accountId`, `timestamp_client`) are
 * injected here. The wire format crams envelope into `args` because
 * Replicache forces it; this wrapper is the client-side counterpart
 * to `parseMutationEnvelope` on the server. Both sides treat envelope
 * as a transport detail rather than something each call site has to
 * remember to assemble.
 *
 * `accountId` is captured at wrap time — the Replicache client is
 * per-(account, entity) so it doesn't change for the client's lifetime.
 * `timestamp_client` is stamped at the moment of the call.
 *
 * @template {Record<string, (args: any) => any>} M
 * @param {M} rawMutate
 * @param {{ accountId: string | null }} envelope
 * @returns {M}
 */
function wrapMutators(rawMutate, { accountId }) {
	return /** @type {M} */ (
		new Proxy(
			{},
			{
				get(_, name) {
					const raw = rawMutate[/** @type {string} */ (name)];
					if (typeof raw !== 'function') return undefined;
					return (/** @type {Record<string, unknown>} */ body) =>
						raw({
							...body,
							accountId,
							timestamp_client: new Date()
						});
				}
			}
		)
	);
}

/**
 * Initializes the Replicache Client stuff.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 */
export function InitReplicacheClient({ accountId, listId }) {
	const licenseKey = import.meta.env.VITE_REPLICACHE_LICENSE_KEY;
	if (!licenseKey) {
		throw new Error('Missing VITE_REPLICACHE_LICENSE_KEY');
	}

	const protocol = `http${dev ? '' : 's'}:`;

	const path = entityPath(listId);
	const pullURL = `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/${path}/pull?l=${listId}`;
	const pushURL = `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/${path}/push?l=${listId}`;

	return new Replicache({
		licenseKey,
		// logLevel: import.meta.env.DEV ? 'debug' : 'error',
		mutators: mutators,
		// Template string to create something like `userId123:listId123`.
		// If no Account ID, it'll be `null:listId123`.
		name: `${accountId}:${listId}`,
		// Event-driven sync: poke via websocket triggers pulls; no polling.
		// pushDelay: null,
		// pullInterval: null,
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
 * @param {string} url
 * @returns {import('replicache').Pusher}
 */
function makePusher(url) {
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
function makePuller(url) {
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
			response: await response.json()
		};
	};
}
