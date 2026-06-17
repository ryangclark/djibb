const BASE = import.meta.env.VITE_API_BASE_URL;

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

/**
 * One entry of an entity's audit log. Mirrors `MutationLogEntry` on the
 * server (workers/src/list/sql.ts). Times are unix **seconds**;
 * `timestamp_server` is the authoritative server clock, `timestamp_client`
 * the author's clock (may be null for offline-queued mutations).
 *
 * @typedef {object} AuditEntry
 * @property {number} seq Opaque, monotonically-increasing cursor.
 * @property {number} id Per-client mutation id.
 * @property {string} client_id
 * @property {string|null} account_id The acting account.
 * @property {string} name Mutation name (e.g. "inviteByIdentity").
 * @property {string} status "succeeded" | "error" | "skipped" | "unknown".
 * @property {string|null} args Raw stringified mutation body — `JSON.parse`
 *   it to inspect. Kept as a string across the DO RPC boundary.
 * @property {number|null} timestamp_client
 * @property {number|null} timestamp_server
 */

/**
 * @typedef {object} AuditPage
 * @property {AuditEntry[]} entries Newest-first.
 * @property {number|null} nextBefore Pass as `before` to load older
 *   entries, or null when the end of the log is reached.
 */

/**
 * Fetch a page of a workspace's audit log (owner/admin only — the worker
 * returns 403 otherwise). The endpoint lives on the entity router
 * (`/workspace/audit?l=<id>`), the same backend that serves the
 * workspace's Replicache sync.
 *
 * @param {object} input
 * @param {string} input.workspaceId Full prefixed id (e.g. "workspace/0Hb…").
 * @param {string|null} [input.accountId] Active account; pins role
 *   resolution via the `X-Djibb-Active-Account` header.
 * @param {number} [input.limit] 1–200, default server-side is 50.
 * @param {number|null} [input.before] `seq` cursor for "load older".
 * @returns {Promise<AuditPage>}
 */
export async function fetchWorkspaceAudit({
	workspaceId,
	accountId = null,
	limit,
	before = null
}) {
	const params = new URLSearchParams({ l: workspaceId });
	if (limit != null) params.set('limit', String(limit));
	if (before != null) params.set('before', String(before));

	/** @type {Record<string, string>} */
	const headers = {};
	if (accountId) headers[ACTIVE_ACCOUNT_HEADER] = accountId;

	const res = await fetch(`${BASE}/workspace/audit?${params}`, {
		credentials: 'include',
		headers
	});
	if (res.status === 403) {
		throw new Error('forbidden');
	}
	if (!res.ok) {
		throw new Error(`audit fetch failed: ${res.status}`);
	}
	return res.json();
}
