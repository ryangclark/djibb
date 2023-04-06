// https://github.com/mvasigh/sveltekit-mdsvex-blog/blob/main/src/lib/slugFromPath.ts
export function slugFromPath(path: string) {
	return path.match(/([\w-]+)\.(svelte\.md|md|svx)/i)?.[1] ?? null;
}
