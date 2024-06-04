import { Lucia } from 'lucia';
import { D1Adapter } from '@lucia-auth/adapter-sqlite';

import { dev } from '$app/environment';

/**
 * Creates a new Lucia instance using the given D1 binding Cloudflare
 * provides with every request.
 * @param {D1Database} D1
 */
export function initialize_lucia(D1) {
	const adapter = new D1Adapter(D1, {
		user: 'users',
		session: 'sessions'
	});

	return new Lucia(adapter, {
		sessionCookie: {
			attributes: {
				// set to `true` when using HTTPS
				secure: !dev
			}
		}
	});
}
