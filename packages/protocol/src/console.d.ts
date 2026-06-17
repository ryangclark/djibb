/**
 * Minimal ambient `console` for the protocol package.
 *
 * `tsconfig.json` sets `types: []` and `lib: ["es2022"]` on purpose, so
 * that anything Cloudflare/Node/DOM-shaped leaking into protocol is a
 * typecheck error (ADR 0014). `console`, however, is a universal runtime
 * global — present in Workers, browsers, and Node alike — and protocol
 * mutators use it for a handful of defensive diagnostics. Declaring just
 * the methods we use keeps the package runtime-agnostic without dragging
 * in the whole DOM or Node typings.
 */
declare const console: {
    error(...data: unknown[]): void;
    warn(...data: unknown[]): void;
};
