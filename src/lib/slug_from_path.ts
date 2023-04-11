/**
 * `file_name_from_path` pulls the file name from the full file path.
 * 
 * See:
 * https://github.com/mvasigh/sveltekit-mdsvex-blog/blob/main/src/lib/slugFromPath.ts
 * @param path full file path (e.g. '/blog/posts/2022-07-14.md')
 * @returns file name (e.g. '2022-07-14')
 */
export function file_name_from_path(path: string) {
	return path.match(/([\w-]+)\.(svelte\.md|md|svx)/i)?.[1] ?? null;
}
