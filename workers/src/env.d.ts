/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` types the test `env` as `Cloudflare.Env`. We have no
// generated `worker-configuration.d.ts`, so seed it from the Worker's own
// `Bindings`. Using a type alias (not a top-level import) keeps this file a
// script, so the `*?raw` ambient module below stays global.
type WorkerBindings = import("./index").Bindings;
declare namespace Cloudflare {
	interface Env extends WorkerBindings {}
}

// Wrangler/Vite raw imports (e.g. `import sql from "./x.sql?raw"`).
declare module "*?raw" {
	const content: string;
	export default content;
}
