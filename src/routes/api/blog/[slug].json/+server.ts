import { error } from '@sveltejs/kit';
import { getBlogPostContentBySlug } from '$lib/content';
import type { RequestHandler } from './$types';

// 1 minute, for now...
const CACHE_CONTROL_MAX_AGE = 60;

// https://kit.svelte.dev/docs/routing#server
export const GET = (async ({ params }) => {
	const { slug } = params;

	try {
		const data = await getBlogPostContentBySlug(slug);

		return new Response(JSON.stringify(data), {
			headers: {
				'Cache-Control': `max-age=0, s-maxage=${CACHE_CONTROL_MAX_AGE}`
			}
		});
	} catch (err) {
		// console.log("`API/blog/[slug].json` didn't find slug", slug);
		console.error(err);
		throw error(404);
	}
}) satisfies RequestHandler;
