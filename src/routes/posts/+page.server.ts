import type { PageServerLoad } from './$types';
import { get_blog_posts_chronologically } from '$lib/content';

const MAX_POSTS = 10;

export const load: PageServerLoad = async () => {
	const posts = await get_blog_posts_chronologically(MAX_POSTS);

	// `load` must return serializable data. So, we have to strip out the
	// actual post, which is a Svelte component (not serializable).
	const posts_metadata = Array(posts.length);

	for (let i = 0; i < posts.length; i++) {
		posts_metadata[i] = posts[i].metadata;
	}

	return { posts_metadata };
};
