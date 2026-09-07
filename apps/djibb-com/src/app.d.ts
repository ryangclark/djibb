// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {} — no server-side Locals today. (Previously held
		// `lucia` Session/User types, but nothing populated or read them, and
		// lucia is deprecated — GH #52.)
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DJIBB_AUTH: D1Database;
				DJIBB_LIST: DurableObjectNamespace;
			};
			caches: CacheStorage & { default: Cache };
			cf: CfProperties;
			// context: {
			// 	waitUntil(promise: Promise<any>): void;
			// };
			ctx: ExecutionContext;
		}
	}
}

export {};
