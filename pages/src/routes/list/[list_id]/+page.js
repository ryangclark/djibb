import { IdTypes } from '$djibb/id';

/** @type {import('./$types').PageLoad} */
export const load = ({ params }) => {
	// Just return `params` to provide the URL pattern stuff
	// so the List component can read its own ID.
	return { list_id: `${IdTypes['list']}/${params.list_id}` };
};
