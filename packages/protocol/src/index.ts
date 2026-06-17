/**
 * `@djibb/protocol` — the djibb contract.
 *
 * Root barrel. Submodules are also importable directly via the package's
 * `exports` map (e.g. `@djibb/protocol/id`); subpath imports stay the
 * primary surface, mirroring the historical `$djibb/*` layout, while this
 * barrel offers a single entry point as more of the protocol lands here.
 */
export * from './id';
