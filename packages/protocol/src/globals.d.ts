/**
 * Minimal ambient declaration of the Web Crypto global.
 *
 * `@djibb/protocol` is pure (tsconfig `types: []`, no DOM lib, no
 * `@cloudflare/workers-types`) so that anything runtime-specific that
 * sneaks in is a typecheck error. But `id/` legitimately uses Web Crypto,
 * which is available everywhere the protocol runs — browsers, Cloudflare
 * Workers, Node 18+, Deno, Bun. We declare only the surface we depend on,
 * rather than pulling a whole lib that would also drag in `window`/`document`.
 *
 * Consumers (workers, pages) compile this source under their own tsconfigs,
 * where `crypto` is already declared by their `types`; this file only
 * satisfies the protocol package's standalone typecheck.
 */
declare const crypto: {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};
