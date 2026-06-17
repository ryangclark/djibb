import { IdTypes } from '@djibb/protocol/id';

/** @type {import('./$types').PageLoad} */
export const load = ({ params }) => {
	// URL carries only the ID suffix because `t/` is the route segment;
	// reconstruct the full prefixed ID for downstream consumers.
	return { list_id: `${IdTypes['template']}/${params.id}` };
};
