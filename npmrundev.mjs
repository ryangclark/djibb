/**
 * Copied from Dario Piotrowicz's example of how to run SvelteKit
 * and a Durable Object alongside one another LOCALLY!
 *
 * @see https://github.com/dario-piotrowicz/sveltekit-durable-object-local-usage-example/
 *
 * I don't really know how this all works, other than to say that it
 * runs the Worker that runs the DO first, then runs the SvelteKit app.
 */

import { fork, spawn } from 'node:child_process';
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
        /**
         * Toggle 'workers' below if you get a weird error running `npm start`,
         * especially after changing any dependencies, because npm 
         * likes to move where it stores node_modules.
         */
        // 'workers', 
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
        env: {
            BROWSER: 'none',
            PWD: resolve(__dirname, 'workers'),
            ...process.env,
        },
        signal,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
);

wranglerDevProcess.on('message', () => {
    wranglerDevResolve();
});

wranglerDevProcess.on('error', error => {
    console.error('wranglerDevProcess:', error);
    terminateProcesses();
});

wranglerDevProcess.on('SIGINT', () => {
    terminateProcesses();
});

wranglerDevProcess.on('SIGTERM', () => {
    terminateProcesses();
});

await wranglerDevPromise;

const svelteKitProcess = spawn('npm', ['run', 'dev'], {
    cwd: resolve(__dirname, 'pages'),
    env: { PWD: resolve(__dirname, 'pages'), ...process.env },
    signal,
    stdio: 'inherit',
});

svelteKitProcess.on('error', error => {
    console.error('svelteKitProcess:', error);
    terminateProcesses();
});

svelteKitProcess.on('exit', () => {
    terminateProcesses();
});

function terminateProcesses() {
    if (wranglerDevProcess) {
        wranglerDevProcess.kill();
    }
    if (svelteKitProcess) {
        svelteKitProcess.kill();
    }
    process.exit();
}
