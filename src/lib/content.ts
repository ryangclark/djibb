import { slugFromPath } from './slug_from_path';

export async function getBlogPostContentBySlug(slug: string) {
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
	const modules = import.meta.glob(`/blog/posts/*.{md,svx,svelte.md}`);

	let matchedPost: { filePath?: string; resolver?: App.MdsvexResolver } = {};

	for (const [filePath, resolver] of Object.entries(modules)) {
		const pathSlug = slugFromPath(filePath);

		if (pathSlug === slug) {
			// console.log('MATCH!!', resolver);

			matchedPost = { filePath, resolver: resolver as unknown as App.MdsvexResolver };
			break;
		}
	}

	const post = await matchedPost?.resolver?.();

	if (!post?.metadata?.created_at) {
		// Couldn't resolve the post.
		throw Error(`post not found for slug "${slug}"`);
	}

	return {
		component: post.default,
		frontmatter: post.metadata,
	};
}
