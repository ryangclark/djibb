import { WebSocket } from 'partysocket';
import { dev } from '$app/environment';

/**
 * Initialize websocket!
 * @param {string} list_id
 * @returns
 */
export function initialize(list_id) {
	const url = `ws${dev ? '' : 's'}://${
		import.meta.env.VITE_REPLICACHE_BASE_URL
	}/list/websocket?l=${list_id}`;

	return new WebSocket(url);
}
