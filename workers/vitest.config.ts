import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// In `@cloudflare/vitest-pool-workers` >=0.14 the pool is registered via
// the `cloudflareTest` Vite plugin (vitest 4 pool-rework migration).
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
    // `test/setup.ts` neutralizes the `EMAIL` send_email binding so no
    // test ever hits miniflare's domain-validating sender (whose
    // detached-promise rejection otherwise crashes unrelated tests under
    // the shared pool-workers `env`). Runs inside the worker.
    test: {
        setupFiles: ['./test/setup.ts'],
    },
});
