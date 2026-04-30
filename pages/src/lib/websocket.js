import { WebSocket } from 'partysocket';
import { dev } from '$app/environment';
import { IdTypes } from '$djibb/id';

/**
 * Initialize websocket!
 * @param {string} entity_id
 * @returns
 */
export function initialize(entity_id) {
	const path = entity_id.startsWith(`${IdTypes.template}/`)
		? 'template'
		: 'list';
	const url = `ws${dev ? '' : 's'}://${
		import.meta.env.VITE_REPLICACHE_BASE_URL
	}/${path}/websocket?l=${entity_id}`;

	return new WebSocket(url);
}
