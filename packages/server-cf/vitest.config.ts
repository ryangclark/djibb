import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Two projects:
//
// `workers` — the existing suite, run inside workerd via
// `@cloudflare/vitest-pool-workers` (>=0.14 registers the pool via the
// `cloudflareTest` Vite plugin; vitest 4 pool-rework migration).
//
// `meta` — plain-node tests that need the filesystem (e.g. the ADR 0025
// D1-discipline guard scans src/). workerd has no `node:fs`, so these
// cannot run in the pool.
//
// `miniflare.bindings` supplies test-only values for the plaintext vars
// the Worker reads at request time. These aren't in `wrangler.toml`
// (they're production secrets/dashboard vars), so without them
// `c.env.AUTHORIZED_DOMAINS.split(';')` throws at the CORS/CSRF
// middleware and every fetch-driven test 500s (see test/first.test.ts,
// test/initReconciliation.test.ts). `AUTHORIZED_DOMAINS` must include the
// Origin the tests POST from (http://localhost:5173) so the CSRF check
// passes.
export default defineConfig({
    test: {
        projects: [
            {
                plugins: [
                    cloudflareTest({
                        wrangler: { configPath: './wrangler.toml' },
                        miniflare: {
                            bindings: {
                                API_ORIGIN: 'http://localhost:8787',
                                AUTHORIZED_DOMAINS: 'http://localhost:5173',
                            },
                        },
                    }),
                ],
                test: {
                    name: 'workers',
                    include: ['test/**/*.test.ts'],
                    exclude: ['test/meta/**'],
                    // `test/setup.ts` neutralizes the `EMAIL` send_email
                    // binding so no test ever hits miniflare's
                    // domain-validating sender (whose detached-promise
                    // rejection otherwise crashes unrelated tests under
                    // the shared pool-workers `env`). Runs inside the
                    // worker.
                    setupFiles: ['./test/setup.ts'],
                },
            },
            {
                test: {
                    name: 'meta',
                    environment: 'node',
                    include: ['test/meta/**/*.test.ts'],
                },
            },
        ],
    },
});
