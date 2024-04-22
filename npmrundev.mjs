/**
 * Copied from Dario Piotrowicz's example of how to run SvelteKit
 * and a Durable Object alongside one another LOCALLY!
 *
 * @see https://github.com/dario-piotrowicz/sveltekit-durable-object-local-usage-example/
 *
 * I don't really know how this all works, other than to say that it
 * runs the Worker that runs the DO first, then runs the SvelteKit app.
 */

import { fork, execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let wranglerDevResolve;

// Use a Promise, with its `resolve` function stored in the variable
// above, to hold off on starting the SvelteKit dev server until the
// Worker is up and running.
const wranglerDevPromise = new Promise(
    resolve => (wranglerDevResolve = resolve)
);

const controller = new AbortController();
const { signal } = controller;

const wranglerDevProcess = fork(
    // Navigate to the file where we can invoke `wrangler` programmatially.
    join(
        __dirname,
        'node_modules',
        'wrangler',
        'bin',
        'wrangler.js'
    ),
    // The args we'll pass to the module (aka `wrangler`).
    ['dev', '--port=8787'],
    // Options. No idea what these are all about.
    {
        cwd: resolve(__dirname, 'workers'),
        env: { BROWSER: 'none', ...process.env },
        signal,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
).on('message', () => {
    wranglerDevResolve();
});

wranglerDevProcess.on('error', error => {
    controller.abort();
    console.error('wranglerDevProcess:', error);
});

wranglerDevProcess.on('SIGINT', () => {
    controller.abort();
    wranglerDevProcess.exit();
});

wranglerDevProcess.on('SIGTERM', () => {
    wranglerDevProcess.exit();
});

await wranglerDevPromise;

execSync('npm run dev', {
    cwd: resolve(__dirname, 'pages'),
    stdio: 'inherit',
});
