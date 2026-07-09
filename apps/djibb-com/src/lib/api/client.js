// @ts-check
import { createTransport, sessionCookie } from '@djibb/client/transport';
import { apiOrigin } from '$lib/config';

/**
 * The one credentialed transport every `lib/api/*` module shares (arch-review
 * #2). Bound once to the API origin; each module builds its paths and DTO
 * mapping on top. See `@djibb/client/transport` for the request contract
 * (the `activeAccount` header, `DjibbHttpError`).
 *
 * `sessionCookie()` is the browser's credential: send the interactive session
 * cookie, and never set `Origin` (the browser owns that header). Non-browser
 * clients pass `bearerToken(...)` or `anonymous(...)` instead.
 */
export const api = createTransport({
	baseUrl: apiOrigin,
	credential: sessionCookie()
});

export { DjibbHttpError } from '@djibb/client/transport';
