import { IdTypes } from '$djibb/id';

/**
 * Reconstruct the prefixed entity ID for the share route.
 *
 * SvelteKit does NOT propagate parent `+page.js` data to child routes —
 * only `+layout.js` data flows down. So even though `/l/[id]/+page.js`
 * builds `data.list_id`, this route doesn't inherit it. Without this
 * file, `page.data.list_id` is undefined here and `initList()` throws
 * "Missing List Id!" from inside the mount effect, wedging the page on
 * "Loading list…".
 *
 * @type {import('./$types').PageLoad}
 */
export const load = ({ params }) => {
	return { list_id: `${IdTypes['list']}/${params.id}` };
};
