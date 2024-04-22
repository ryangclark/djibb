/** @type {import('./$types').PageLoad} */
export const load = ({ params }) => {
	// Just return `params` to provide the URL pattern stuff
	// so the List component can read its own ID.
	// console.log('+page.js', params.list_id);
	return { list_id: params.list_id };
};
