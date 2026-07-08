import { defineConfig } from 'vitest/config';

// @djibb/client is browser-targeted but its logic (transport, undo stack) is
// framework-agnostic and runs fine under plain node with a stubbed `fetch` —
// this is the package's own unit harness (arch-review #2), separate from
// server-cf's workers pool.
export default defineConfig({
	test: {
		include: ['src/**/*.test.js'],
		environment: 'node'
	}
});
