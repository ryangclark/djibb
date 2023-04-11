import { file_name_from_path } from './slug_from_path';
import type { SvelteComponent } from 'svelte/internal';
const posts_cache = new Map();

let is_processing = false;
let processed_resolver: (
	value: boolean | PromiseLike<boolean>
) => void | undefined;
const is_processed = new Promise<boolean>((resolve) => {
	processed_resolver = resolve;
});

export async function get_blog_posts_chronologically(
	max_post_count: number
): Promise<
	{
		component: SvelteComponent;
		metadata: App.BlogPostMetadata;
	}[]
> {
	process_blog_posts();
	await is_processed;

	const posts: {
		component: SvelteComponent;
		metadata: App.BlogPostMetadata;
	}[] = Array(Math.min(max_post_count, posts_cache.size));

	// While you can iterate over a Map, you can't access values by
	// index (e.g. `posts_cache[1]`). So, we gotta keep track manually instead.
	let current_index = 0;
	for (const post of posts_cache.values()) {
		if (current_index === posts_cache.size) break;

		posts[current_index] = {
			component: post.default as SvelteComponent,
			metadata: post.metadata as App.BlogPostMetadata,
		};
		current_index++;
	}

	// console.log('posts', posts);
	// console.log('allSlugs', allSlugs);

	return posts;
}

/**
 * `get_blog_post_by_slug` pulls the post by the given slug. Throws
 * and error if the post is not found or if the found post is not published.
 */
export async function get_blog_post_by_slug(slug: string) {
	process_blog_posts();
	await is_processed;

	const post = posts_cache.get(slug);

	if (!post?.metadata?.published) {
		// Couldn't resolve the post.
		throw Error(
			`\`get_blog_post_by_slug()\` error: post not found for slug "${slug}"`
		);
	}

	return {
		component: post.default,
		metadata: post.metadata as App.BlogPostMetadata,
	};
}

async function process_blog_posts() {
	if (is_processing) return;
	is_processing = true;

	// `import.meta.glob()` is a function vite runs at compile-time
	// (I think that's when...?). The returned value of that function
	// is then replaced in the code. That means code here of
	//
	//      const modules = import.meta.glob(`/blog/posts/*.{md,svx,svelte.md}`);
	//
	// is transformed to
	//
	//      const modules = {
	//          '/blog/posts/2022-07-14.md': () => import('/blog/posts/2022-07-14.md'),
	//          '/blog/posts/2022-07-18.md': () => import('/blog/posts/2022-07-18.md'),
	//          '/blog/posts/2022-07-25.md': () => import('/blog/posts/2022-07-25.md'),
	//          '/blog/posts/2022-08-29.md': () => import('/blog/posts/2022-08-29.md')
	//      };
	//
	// That new object has keys of the full file path (that matched
	// the input pattern), with keys of a function to import that file.
	// Call the function to import the file.

	// It should be relatively cheap to use this to get all blog posts
	// file names in the full directory, then find a match on the
	// exact requested slug. Plus, I think that's how you have to do it
	// with vite:
	//
	//    > You should also be aware that all the arguments in the
	//    > import.meta.glob must be passed as literals. You can NOT
	//    > use variables or expressions in them.
	//
	// See: https://vitejs.dev/guide/features.html#glob-import
	const found_records = import.meta.glob(`/blog/posts/*.{md,svx,svelte.md}`);

	// NOTE: this doesn't make use of `Promise.all()` like it maybe could
	// to collect the `file_resolver` promises resolving. We're currently
	// waiting on each one to wait before moving through to the next loop.
	//
	// I don't know if that will make much of a difference, to be honest,
	// because it's just file system stuff. Not, like, network requests.
	// But if problems arise, maybe look into that.
	for (const [file_path, file_resolver] of Object.entries(found_records)) {
		const file_name = file_name_from_path(file_path);

		if (!file_name) {
			console.error(
				`\`process_blog_posts()\` error: bad file name from file path "${file_path}"`
			);
			continue;
		}

		let resolved_file;

		try {
			resolved_file = (await file_resolver()) as App.MdsvexFile;

			if (!resolved_file) {
				console.error(
					`\`process_blog_posts()\` resolved file for file path "${file_path}" is falsy!`
				);

				continue;
			}
		} catch (error) {
			console.error(
				`\`process_blog_posts()\` error resolving file for file path "${file_path}":`,
				error
			);

			continue;
		}

		if (!resolved_file?.metadata?.slug) {
			console.error(
				`\`process_blog_posts()\` resolved file for file path "${file_path}" has no slug!`
			);

			continue;
		}

		if (posts_cache.get(resolved_file.metadata.slug)) {
			console.error(
				`\`process_blog_posts()\` error: \`posts_cache\` already has value for slug "${resolved_file.metadata.slug}"!`
			);

			continue;
		}

		// For now, we're caching the full resolved file.
		// In the future, that might be a problem. Too big and all that.
		// At that point, we might be able to just cache the resolver
		// function, then call that function whenever we need it.
		// Not even sure if that'll work. Not a today problem.
		//
		// Assuming that the filesystem will return the file names
		// in alphabetical order. Since we have the file names as date
		// strings, that means that the posts should be inserted into the
		// Map here in chronological order. Two birds!
		posts_cache.set(resolved_file.metadata.slug, resolved_file);
	}

	// Mark the blog-post processing as complete.
	if (!processed_resolver) {
		console.error('`processed_resolver` is falsy!');
		throw new Error('Could not mark posts as procesesed.');
	}

	processed_resolver(true);
}
