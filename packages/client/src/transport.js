// @ts-check
/**
 * The one credentialed-fetch transport for the djibb webapp (arch-review #2).
 *
 * Before this module, every `lib/api/*.js` file re-implemented the same
 * skeleton: read `VITE_API_BASE_URL`, set `credentials: 'include'`, hand-wire
 * the `X-Djibb-Active-Account` header, and improvise error handling. That
 * drift is what this centralizes.
 *
 * `@djibb/client` is framework- and env-agnostic (ADR 0014: no Svelte, no
 * `import.meta.env`). So the base URL is *injected* — the app reads its env
 * once and calls `createTransport({ baseUrl })`; `fetch` is injectable too so
 * the transport is unit-testable with a stub.
 *
 * This is the browser sibling of the CLI's `djibbRequestHeaders`/`push`/`pull`
 * primitive in `server-cf/bin/djibb.ts`. They are deliberately separate: the
 * CLI authenticates server-to-server (Bearer + `Origin` CSRF, no cookies),
 * the webapp with the interactive cookie session. Unifying them is a later
 * step (arch-review #5), not this one.
 */

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

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
		super(`${status} ${statusText || 'request failed'}: ${url}`);
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
 * @property {Record<string, string>} [headers] Extra headers, merged last.
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
 * @param {typeof fetch} [config.fetch] Injectable for tests; defaults to the
 *   global `fetch`.
 * @returns {Transport}
 */
export function createTransport({ baseUrl, fetch: fetchImpl = globalThis.fetch }) {
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

		const url = joinUrl(baseUrl, path);
		const res = await fetchImpl(url, {
			method,
			credentials: 'include',
			headers: { ...headers, ...opts.headers },
			body
		});

		if (res.status === 404 && opts.notFoundAsNull) {
			return /** @type {any} */ (null);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new DjibbHttpError(res.status, res.statusText, text, res.headers, url);
		}
		if (res.status === 204) return /** @type {any} */ (undefined);

		const contentType = res.headers.get('Content-Type') || '';
		if (!contentType.includes('application/json')) {
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
