import { IdTypes } from '@djibb/protocol/id';

/**
 * Reconstruct the prefixed entity ID for the share route. Twin of
 * `/l/[id]/share/+page.js`; see that file for the SvelteKit-data-
 * inheritance gotcha that makes this file load-bearing.
 *
 * @type {import('./$types').PageLoad}
 */
export const load = ({ params }) => {
	return { list_id: `${IdTypes['template']}/${params.id}` };
};
