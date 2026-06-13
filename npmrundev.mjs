/**
 * Runs the Cloudflare Worker (Durable Objects + API) and the SvelteKit
 * app side by side for local development. Originally adapted from Dario
 * Piotrowicz's example, since rewritten:
 *
 * @see https://github.com/dario-piotrowicz/sveltekit-durable-object-local-usage-example/
 *
 * Flow: start `wrangler dev` (the Worker), wait until it's actually
 * accepting connections on its port, then start the SvelteKit dev
 * server. Ctrl-C tears both down cleanly.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKER_PORT = 8787;
const WORKER_URL = `http://localhost:${WORKER_PORT}`;
const WORKER_READY_TIMEOUT_MS = 30_000;

const workersDir = resolve(__dirname, 'workers');
const pagesDir = resolve(__dirname, 'pages');

// Start the Worker via its own `npm run dev` script (same approach we
// use for SvelteKit below). Passing `--port` after `--` forwards it to
// `wrangler dev`. This avoids hard-coding a path into node_modules,
// which broke whenever npm relocated the hoisted wrangler binary.
const wranglerDevProcess = spawn(
    'npm',
    ['run', 'dev', '--', `--port=${WORKER_PORT}`],
    {
        cwd: workersDir,
        env: { ...process.env, BROWSER: 'none', PWD: workersDir },
        stdio: 'inherit',
    }
);

let svelteKitProcess;
let terminating = false;

wranglerDevProcess.on('error', error => {
    console.error('wranglerDevProcess:', error);
    terminateProcesses(1);
});

wranglerDevProcess.on('exit', code => {
    // If the Worker dies, take the whole dev environment down with it.
    if (!terminating) terminateProcesses(code ?? 0);
});

// Wait for the Worker to actually accept connections before starting
// SvelteKit, then launch it. Polling the port is sturdier than relying
// on a wrangler IPC "ready" message, which could change between versions
// (and would hang this script forever if it never arrived).
await waitForWorker();
startSvelteKit();

function startSvelteKit() {
    if (terminating) return;

    svelteKitProcess = spawn('npm', ['run', 'dev'], {
        cwd: pagesDir,
        env: { ...process.env, PWD: pagesDir },
        stdio: 'inherit',
    });

    svelteKitProcess.on('error', error => {
        console.error('svelteKitProcess:', error);
        terminateProcesses(1);
    });

    svelteKitProcess.on('exit', code => {
        if (!terminating) terminateProcesses(code ?? 0);
    });
}

async function waitForWorker() {
    const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (terminating) return;
        try {
            // Any HTTP response (even a 404) means the Worker is up and
            // listening — that's all we need before starting SvelteKit.
            await fetch(WORKER_URL);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 250));
        }
    }

    console.error(
        `Worker did not become ready on ${WORKER_URL} within ` +
            `${WORKER_READY_TIMEOUT_MS / 1000}s.`
    );
    terminateProcesses(1);
}

function terminateProcesses(code = 0) {
    // Guard against re-entry: the exit/signal handlers can fire more
    // than once (this was the cause of needing to mash Ctrl-C).
    if (terminating) return;
    terminating = true;

    wranglerDevProcess?.kill('SIGTERM');
    svelteKitProcess?.kill('SIGTERM');

    process.exit(code);
}

// Handle the signal on THIS process (the parent). Previously these were
// attached to the child, so Ctrl-C against the parent never ran cleanup,
// orphaning the Worker on its port and forcing repeated Ctrl-C.
process.on('SIGINT', () => terminateProcesses(0));
process.on('SIGTERM', () => terminateProcesses(0));
