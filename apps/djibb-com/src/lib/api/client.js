// @ts-check
import { createTransport } from '@djibb/client/transport';
import { apiOrigin } from '$lib/config';

/**
 * The one credentialed transport every `lib/api/*` module shares (arch-review
 * #2). Bound once to the API origin; each module builds its paths and DTO
 * mapping on top. See `@djibb/client/transport` for the request contract
 * (`credentials: 'include'`, the `activeAccount` header, `DjibbHttpError`).
 */
export const api = createTransport({ baseUrl: apiOrigin });

export { DjibbHttpError } from '@djibb/client/transport';
