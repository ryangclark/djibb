import { WebSocket } from 'partysocket';

/**
 * Initialize websocket!
 * @param {string} list_id
 * @returns
 */
export function initialize(list_id) {
	const url = `ws://${
		import.meta.env.VITE_REPLICACHE_BASE_URL
	}/list/${list_id}/websocket`;

	return new WebSocket(url);
}
