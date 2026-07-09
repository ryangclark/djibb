// @ts-check
/**
 * The one credentialed-fetch transport for every djibb client (arch-review
 * #2, generalized in #5).
 *
 * Before this module, every `lib/api/*.js` file re-implemented the same
 * skeleton: read `VITE_API_BASE_URL`, set `credentials: 'include'`, hand-wire
 * the `X-Djibb-Active-Account` header, and improvise error handling. The CLI
 * hand-rolled a *second* copy for its own auth model. That drift is what this
 * centralizes.
 *
 * `@djibb/client` is framework- and env-agnostic (ADR 0014: no Svelte, no
 * `import.meta.env`). So the base URL is *injected* — the app reads its env
 * once and calls `createTransport({ baseUrl, credential })`; `fetch` is
 * injectable too so the transport is unit-testable with a stub.
 *
 * **Credential presentation is the one axis that used to fork this code.**
 * A browser presents the interactive cookie session and must *not* set
 * `Origin` (a forbidden header — the browser sets it). A non-browser client
 * (CLI, bot, integration) presents an `issued_credentials` Bearer token, or
 * nothing at all, and *must* set `Origin` explicitly to clear the worker's
 * CSRF gate (`index.ts` rejects non-GET requests whose `Origin` isn't in
 * `AUTHORIZED_DOMAINS`). Pass the matching strategy below; everything else
 * about a djibb request is identical.
 */

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

/**
 * How a client presents its identity on each request. A strategy contributes
 * `credentials` and/or `headers` to every call.
 *
 * Spelled as a literal union rather than the DOM's `RequestCredentials` so
 * this package's public types resolve under a Node `lib`/`types` too — the
 * CLI consumes them without pulling in the whole DOM lib.
 *
 * @typedef {object} Credential
 * @property {'omit'|'same-origin'|'include'} [credentials]
 * @property {Record<string, string>} [headers]
 */

/**
 * Browser clients: send the interactive session cookie. `Origin` is set by
 * the browser and cannot be set here.
 *
 * @returns {Credential}
 */
export function sessionCookie() {
	return { credentials: 'include' };
}

/**
 * Non-browser clients authenticating as an Account via an `issued_credentials`
 * API key (ADR 0022). The token says *who* the caller is; the server's auth
 * layer decides what that identity may do.
 *
 * @param {string} token
 * @param {{ origin: string }} opts `origin` must be an `AUTHORIZED_DOMAINS` entry.
 * @returns {Credential}
 */
export function bearerToken(token, { origin }) {
	return {
		credentials: 'omit',
		headers: { Authorization: `Bearer ${token}`, Origin: origin }
	};
}

/**
 * Non-browser clients calling with no credential at all. The server resolves
 * them to the target entity's `default_role` (e.g. `submitter` on the
 * Contributed List, which admits `createListItem` and nothing else).
 *
 * @param {{ origin: string }} opts `origin` must be an `AUTHORIZED_DOMAINS` entry.
 * @returns {Credential}
 */
export function anonymous({ origin }) {
	return { credentials: 'omit', headers: { Origin: origin } };
}

/**
 * A non-2xx (or otherwise failed) response from the djibb API. Carries
 * everything a caller needs to specialize handling without re-reading the
 * body: the status, the response text, and a headers snapshot (e.g. the
 * magic-link flow reads `Retry-After` off a 429; connected/audit branch on
 * 403).
 */
export class DjibbHttpError extends Error {
	/**
	 * @param {number} status
	 * @param {string} statusText
	 * @param {string} bodyText
	 * @param {Headers} headers
	 * @param {string} url
	 */
	constructor(status, statusText, bodyText, headers, url) {
		// The URL stays a field for logs but is kept out of `message` — call
		// sites render `err.message` straight into the page, and a full API
		// URL with query params is not something to show a user.
		super(`${status} ${statusText || 'request failed'}`);
		this.name = 'DjibbHttpError';
		this.status = status;
		this.statusText = statusText;
		this.bodyText = bodyText;
		this.headers = headers;
		this.url = url;
	}
}

/**
 * Join a base origin and a path with exactly one slash between them. The
 * base may carry a trailing slash (the prod origin historically did); the
 * path may be absolute (`/entities`) or bare (`entities`).
 *
 * @param {string} baseUrl
 * @param {string} path
 */
function joinUrl(baseUrl, path) {
	return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/**
 * @typedef {object} RequestOptions
 * @property {string|null} [activeAccount] When set, sent as
 *   `X-Djibb-Active-Account` so the server pins role resolution to this
 *   account (ADR 0021). Omit it and no header is sent — the four path-scoped
 *   reads (`/shared`, `/trash`, `/invitations`, `/workspaces`) never sent one.
 * @property {unknown} [json] A JSON request body. Sets `Content-Type` and
 *   stringifies. Omit for GET/DELETE with no body.
 * @property {boolean} [notFoundAsNull] Map a 404 to `null` instead of
 *   throwing — for lookups whose "not found" is a normal answer the server
 *   deliberately can't distinguish from "not authorized" (both 404).
 * @property {'json'|'none'} [parse] What to do with a successful body.
 *   Default `'json'`: parse it, and *throw* if it isn't JSON — a 200 that
 *   should have carried a body but didn't is a bug we want loud, not a
 *   silent `undefined` that explodes at the caller's `.map()`. Pass `'none'`
 *   for the endpoints that deliberately answer 200 with an empty body
 *   (`/auth/magic/request` soft-200s to avoid disclosing account existence).
 *   A `204`/`205` is always empty and never parsed.
 * @property {Record<string, string>} [headers] Extra headers. Any entry whose
 *   name collides (case-insensitively) with a credential header or
 *   `X-Djibb-Active-Account` is dropped — those are authz inputs to
 *   server-side role resolution (ADR 0021/0022), not convenience knobs.
 */

/**
 * @typedef {object} Transport
 * @property {<T = unknown>(path: string, opts?: RequestOptions) => Promise<T>} get
 * @property {<T = unknown>(path: string, opts?: RequestOptions) => Promise<T>} post
 * @property {<T = unknown>(path: string, opts?: RequestOptions) => Promise<T>} patch
 * @property {<T = unknown>(path: string, opts?: RequestOptions) => Promise<T>} del
 * @property {<T = unknown>(method: string, path: string, opts?: RequestOptions) => Promise<T>} request
 */

/**
 * Build a transport bound to one API origin.
 *
 * @param {object} config
 * @param {string} config.baseUrl The API origin, e.g. `http://localhost:8787`.
 * @param {Credential} config.credential How this client presents its identity —
 *   `sessionCookie()`, `bearerToken(token, { origin })`, or `anonymous({ origin })`.
 * @param {typeof fetch} [config.fetch] Injectable for tests; defaults to the
 *   global `fetch`, resolved *per call* so a later-installed interceptor
 *   (MSW, instrumentation) isn't bypassed by an init-time snapshot.
 * @returns {Transport}
 */
export function createTransport({
	baseUrl,
	credential,
	fetch: fetchImpl = (...args) => globalThis.fetch(...args)
}) {
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {RequestOptions} [opts]
	 */
	async function request(method, path, opts = {}) {
		/** @type {Record<string, string>} */
		const headers = {};
		if (opts.activeAccount) headers[ACTIVE_ACCOUNT_HEADER] = opts.activeAccount;

		/** @type {string | undefined} */
		let body;
		if (opts.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(opts.json);
		}

		// The credential's headers (Authorization, Origin) and the transport's
		// own (active-account, Content-Type) are authz/protocol inputs, and
		// must not be overridable by a caller's convenience headers. HTTP
		// header names are case-insensitive, and `Headers` *combines* two
		// spellings of one name ("Bearer spoofed, Bearer real") rather than
		// letting one win — so a plain spread only protects the exact-case
		// match. Drop any extra whose name collides case-insensitively.
		const reserved = { ...credential.headers, ...headers };
		const reservedNames = new Set(Object.keys(reserved).map((k) => k.toLowerCase()));
		const extras = Object.fromEntries(
			Object.entries(opts.headers ?? {}).filter(([k]) => !reservedNames.has(k.toLowerCase()))
		);

		const url = joinUrl(baseUrl, path);
		const res = await fetchImpl(url, {
			method,
			credentials: credential.credentials,
			headers: { ...extras, ...reserved },
			body
		});

		if (res.status === 404 && opts.notFoundAsNull) {
			return /** @type {any} */ (null);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new DjibbHttpError(res.status, res.statusText, text, res.headers, url);
		}
		// 204/205 are defined to have no body; `parse: 'none'` is the caller
		// declaring the same for a 200. Everything else must be JSON — let
		// `res.json()` throw rather than silently hand back `undefined`.
		if (opts.parse === 'none' || res.status === 204 || res.status === 205) {
			return /** @type {any} */ (undefined);
		}
		return res.json();
	}

	return {
		request,
		get: (path, opts) => request('GET', path, opts),
		post: (path, opts) => request('POST', path, opts),
		patch: (path, opts) => request('PATCH', path, opts),
		del: (path, opts) => request('DELETE', path, opts)
	};
}
