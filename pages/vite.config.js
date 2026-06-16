import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	ssr: {
		// `@djibb/protocol` and `@djibb/client` ship source (no build step —
		// ADR 0014). Force Vite to bundle/transpile them for SSR instead of
		// externalizing to Node, which can't load `.ts` (or these `.js`
		// workspace sources) at runtime.
		noExternal: ['@djibb/protocol', '@djibb/client']
	}
});
