// @ts-check
import { createUnflushedLedger } from '@djibb/client/unflushed';

/**
 * The webapp's binding of the unflushed-work ledger (GH #43) to
 * `localStorage`.
 *
 * `@djibb/client` never reaches for browser or framework globals (ADR
 * 0014) — it's imported by the CLI, which has no `localStorage` — so it
 * takes storage as an adapter and this file supplies it, the same way
 * `config.js` supplies the API origin.
 *
 * `localStorage` and not `sessionStorage`: the entire point is to
 * survive the thing that destroys session state. A per-tab store would
 * be erased by exactly the reload we're trying to recover from.
 */

/** @type {import('@djibb/client/unflushed').LedgerStorage} */
const storage = {
	getItem: (key) => (browserStorage() ? localStorage.getItem(key) : null),
	setItem: (key, value) => browserStorage() && localStorage.setItem(key, value),
	removeItem: (key) => browserStorage() && localStorage.removeItem(key),
	keys: () => (browserStorage() ? Object.keys(localStorage) : [])
};

/**
 * SSR has no `localStorage`. A ledger that reads empty during SSR is
 * correct rather than merely safe: the server can't know about work
 * queued in someone's browser, and the client re-resolves on mount.
 */
function browserStorage() {
	return typeof localStorage !== 'undefined';
}

export const unflushedLedger = createUnflushedLedger({ storage });
