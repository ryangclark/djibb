// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
// and what to do when importing types
declare namespace App {
	// interface Error {}
	// interface Locals {}
	// interface PageData {}
	// interface Platform {}

	// https://github.com/mvasigh/sveltekit-mdsvex-blog/blob/main/src/app.d.ts
	interface MdsvexFile {
		default: import('svelte/internal').SvelteComponent;
		metadata: Record<string, string>;
	}

	// https://github.com/mvasigh/sveltekit-mdsvex-blog/blob/main/src/app.d.ts
	type MdsvexResolver = () => Promise<MdsvexFile>;
}
