// @ts-check
import { deriveOrigins } from '@djibb/client/origins';

/**
 * Single source for the djibb API origin (arch-review #2).
 *
 * Collapses the two old vars — `VITE_API_BASE_URL` (a full URL, for `fetch`)
 * and `VITE_REPLICACHE_BASE_URL` (protocol-less, for `ws://` and Replicache's
 * `baseUrl`) — into one `VITE_DJIBB_ORIGIN`. They always named the same host;
 * carrying it twice, in two formats, was the smell.
 *
 * This module is the *only* place that reads the env. The derivation itself
 * lives in `@djibb/client/origins`, where it's unit-tested; `deriveOrigins`
 * throws a named error when the var is unset, which is what a dev hitting
 * this after upgrading (their `.env` still has the old names) will see.
 */
export const { apiOrigin, wsOrigin, replicacheHost, replicacheSecure } =
	deriveOrigins(import.meta.env.VITE_DJIBB_ORIGIN);
