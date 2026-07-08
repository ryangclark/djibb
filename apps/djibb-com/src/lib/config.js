// @ts-check
/**
 * Single source for the djibb API origin (arch-review #2).
 *
 * Collapses the two old vars — `VITE_API_BASE_URL` (a full URL, for `fetch`)
 * and `VITE_REPLICACHE_BASE_URL` (protocol-less, for `ws://` and Replicache's
 * `baseUrl`) — into one `VITE_DJIBB_ORIGIN`. They always named the same host;
 * carrying it twice, in two formats, was the smell.
 *
 * Everything else derives from that origin's own protocol, which is why this
 * module needs no `$app/environment` `dev` flag: the ws-vs-wss and http-vs-https
 * choices come from whether `VITE_DJIBB_ORIGIN` is `http:` or `https:`, not
 * from a build mode that only approximated it.
 */

/** The API origin, e.g. `http://localhost:8787` (trailing slash trimmed). */
export const apiOrigin = import.meta.env.VITE_DJIBB_ORIGIN.replace(/\/$/, '');

/** The websocket origin: `ws://…` when the API is http, `wss://…` when https. */
export const wsOrigin = apiOrigin.replace(/^http/, 'ws');

const parsed = new URL(apiOrigin);

/** Host without protocol (e.g. `localhost:8787`) — Replicache's `baseUrl`. */
export const replicacheHost = parsed.host;

/** Whether the origin is https — Replicache's `secure`. */
export const replicacheSecure = parsed.protocol === 'https:';
