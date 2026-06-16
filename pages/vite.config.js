import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	ssr: {
		// `@djibb/protocol` ships TypeScript source (no build step — ADR 0014).
		// Force Vite to bundle/transpile it for SSR instead of externalizing it
		// to Node, which can't load `.ts` at runtime.
		noExternal: ['@djibb/protocol']
	}
});
