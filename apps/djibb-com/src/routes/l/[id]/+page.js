import { IdTypes } from '@djibb/protocol/id';

/** @type {import('./$types').PageLoad} */
export const load = ({ params }) => {
	// URL carries only the ID suffix because `l/` is the route segment;
	// reconstruct the full prefixed ID for downstream consumers.
	return { list_id: `${IdTypes['list']}/${params.id}` };
};
