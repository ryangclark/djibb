import type { PageLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getBlogPostContentBySlug } from '$lib/content';

export const load: PageLoad = async ({ params }) => {
	const slug = params.slug;

	const post = await getBlogPostContentBySlug(slug).catch((err) => {
		console.error(err);
		throw error(404);
	});

	return {
		...post,
		slug,
	};
};
