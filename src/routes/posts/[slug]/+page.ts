import type { PageLoad } from './$types';
import { error } from '@sveltejs/kit';
import { get_blog_post_by_slug } from '$lib/content';

export const load: PageLoad = async ({ params }) => {
	const slug = params.slug;

	const post = await get_blog_post_by_slug(slug).catch((err) => {
		console.error(err);
		throw error(404);
	});

	return {
		...post,
		slug,
	};
};
