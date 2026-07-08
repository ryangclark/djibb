// @ts-check
/**
 * Origin derivation for djibb clients.
 *
 * One configured origin drives everything: the fetch base, the Replicache
 * sync endpoint, and the poke websocket. The transport scheme is *read* from
 * that origin rather than approximated by a build-mode flag — pointing a dev
 * build at a remote https worker used to yield `ws://` + `secure: false`.
 *
 * Pure, so it can be tested without a bundler; the app supplies the string
 * (`@djibb/client` never reads env — ADR 0014).
 */

/**
 * @typedef {object} DerivedOrigins
 * @property {string} apiOrigin Fetch base, trailing slash trimmed.
 * @property {string} wsOrigin Websocket origin: `ws://` for http, `wss://` for https.
 * @property {string} replicacheHost Host without scheme — Replicache's `baseUrl`.
 * @property {boolean} replicacheSecure Whether the origin is https — Replicache's `secure`.
 */

/**
 * @param {string | undefined} origin An absolute http(s) URL, e.g. `https://api.djibb.com`.
 * @returns {DerivedOrigins}
 */
export function deriveOrigins(origin) {
	if (!origin) {
		throw new Error(
			'djibb: the API origin is not configured. Set VITE_DJIBB_ORIGIN ' +
				'(e.g. http://localhost:8787). It replaces the former ' +
				'VITE_API_BASE_URL + VITE_REPLICACHE_BASE_URL pair — copy ' +
				'apps/djibb-com/.env.example to .env if you are upgrading.'
		);
	}

	const apiOrigin = origin.replace(/\/$/, '');

	let parsed;
	try {
		parsed = new URL(apiOrigin);
	} catch {
		throw new Error(`djibb: the API origin is not a valid URL: ${origin}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(
			`djibb: the API origin must be http(s), got ${parsed.protocol} in ${origin}`
		);
	}

	const replicacheSecure = parsed.protocol === 'https:';
	return {
		apiOrigin,
		wsOrigin: `${replicacheSecure ? 'wss:' : 'ws:'}//${parsed.host}`,
		replicacheHost: parsed.host,
		replicacheSecure
	};
}
