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
 * @param {string} input.baseUrl API host, no protocol (e.g. `api.djibb.com`)
 * @param {boolean} [input.secure=true] https when true; false for local dev
 * @param {(httpStatusCode: number) => void} [input.onPushStatus]
 *   Observes every push response's HTTP status. The sync tracker
 *   (`createSyncTracker`) uses it to notice persistent 401/403s, which
 *   is the only reliable signal that a session expired mid-edit — the
 *   push is rejected at the envelope check, so no per-mutation outcome
 *   is ever emitted on the websocket channel.
 *
 * The return type is intentionally left to inference: TypeScript reads
 * the concrete mutator generic off the `new Replicache({ mutators })`
 * call so callers see `client.mutate.<name>` for every registered
 * mutator. Annotating it as a bare `Replicache` would erase that
 * generic and collapse `.mutate` to an empty surface.
 */
export function createReplicacheClient({
	accountId,
	listId,
	baseUrl,
	secure = true,
	onPushStatus
}) {
	const protocol = secure ? 'https:' : 'http:';
	const path = entityPath(listId);
	const pullURL = `${protocol}//${baseUrl}/${path}/pull?l=${listId}`;
	const pushURL = `${protocol}//${baseUrl}/${path}/push?l=${listId}`;

	return new Replicache({
		// Replicache no longer requires a license key (it went open
		// source; `licenseKey` is now optional and unused). Omitted.
		mutators: mutators,
		// Template string to create something like `userId123:listId123`.
		// If no Account ID, it'll be `null:listId123`.
		name: storeName(accountId, listId),
		// Event-driven sync: poke via websocket triggers pulls; no polling.
		pullURL,
		pushURL,
		// Custom pusher/puller so the cross-origin push/pull sends the
		// session cookie. Replicache's default fetch omits credentials
		// and the worker would resolve the request as anonymous, which
		// trips auth on lists owned by an authed account.
		pusher: makePusher(pushURL, onPushStatus),
		puller: makePuller(pullURL),
		schemaVersion: SCHEMA_VERSION
	});
}

/** Bump when stored value shapes change; forces old clients to reset. */
export const SCHEMA_VERSION = '1';

/**
 * The local store's identity: one store per (account, entity), so two
 * accounts on one device don't share cached entity data.
 *
 * Shared rather than inlined because the ledger's discard path has to
 * derive the very same IndexedDB name in order to drop it
 * (`discardUnflushed`). If these two ever computed the name separately
 * they could drift, and a discard would silently miss the store it was
 * supposed to destroy — leaving the user's "remove all unsynced
 * changes" quietly not doing that.
 *
 * `null` for the account is a real, meaningful value here: it names the
 * anonymous store. See `resolveEffectiveAccount` for why a *null
 * session* is not the same thing as an *anonymous client*.
 *
 * @param {string | null} accountId
 * @param {string} entityId
 */
export function storeName(accountId, entityId) {
	return `${accountId}:${entityId}`;
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
 * This is also where the unflushed-work ledger is stamped (GH #43), and
 * the ordering is the whole point: the mark is written **synchronously,
 * before** the mutation is handed to Replicache. Marking afterwards —
 * from a pending-count observer, say — would leave a window in which a
 * mutation is durable but unclaimed, and a tab closed in that window
 * strands it forever. Marking first can only over-claim, and a stale
 * claim is self-healing (the sync tracker clears it as soon as it sees
 * an empty queue).
 *
 * @template {Record<string, (args: any) => any>} M
 * @param {M} rawMutate
 * @param {object} envelope
 * @param {string | null} envelope.accountId
 * @param {string} [envelope.listId] Entity being mutated; required to mark
 * @param {import('./unflushed.js').UnflushedLedger} [envelope.ledger]
 * @returns {M}
 */
export function wrapMutators(rawMutate, { accountId, listId, ledger }) {
	return /** @type {M} */ (
		new Proxy(
			{},
			{
				get(_, name) {
					const raw = rawMutate[/** @type {string} */ (name)];
					if (typeof raw !== 'function') return undefined;
					return (/** @type {Record<string, unknown>} */ body) => {
						// Anonymous mutations have no owner to recover them
						// for, so there is nothing to claim.
						if (ledger && accountId && listId) {
							ledger.mark(listId, accountId);
						}
						return raw({
							...body,
							accountId,
							timestamp_client: new Date()
						});
					};
				}
			}
		)
	);
}

/**
 * @param {string} url
 * @param {(httpStatusCode: number) => void} [onStatus]
 *   Notified of every push response status, success or failure. A
 *   network error (offline) rejects the `fetch` and is *not* reported
 *   — the caller distinguishes "can't reach the server" from "the
 *   server said no", and only the latter can mean signed-out.
 * @returns {import('replicache').Pusher}
 */
export function makePusher(url, onStatus) {
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
		onStatus?.(response.status);
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
