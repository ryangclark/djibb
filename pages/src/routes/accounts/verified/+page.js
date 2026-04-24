/** @type {import('./$types').PageLoad} */
export function load({ url }) {
	const accountId = url.searchParams.get('account_id') || '';

	return { accountId };
}
