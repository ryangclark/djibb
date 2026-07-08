import { WebSocket } from 'partysocket';
import { IdTypes } from '@djibb/protocol/id';
import { WS_QUERY_CLIENT_ID } from '@djibb/protocol/websocket/constants';
import { wsOrigin } from '$lib/config';

/**
 * Initialize the websocket for an entity. Per ADR 0006 the URL
 * carries the Replicache `clientID` as `?c=<clientID>` so the DO can
 * tag the socket at accept time and unicast per-mutation outcomes
 * back to the originating tab.
 *
 * @param {string} entity_id
 * @param {string} [client_id] Replicache client id; when omitted the
 *   socket connects untagged and only receives `poke` broadcasts (no
 *   per-mutation outcomes).
 */
export function initialize(entity_id, client_id) {
	const path = entity_id.startsWith(`${IdTypes.template}/`)
		? 'template'
		: entity_id.startsWith(`${IdTypes.workspace}/`)
			? 'workspace'
			: 'list';
	const params = new URLSearchParams({ l: entity_id });
	if (client_id) params.set(WS_QUERY_CLIENT_ID, client_id);
	const url = `${wsOrigin}/${path}/websocket?${params.toString()}`;

	return new WebSocket(url);
}
