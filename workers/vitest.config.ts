import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// In `@cloudflare/vitest-pool-workers` >=0.14 the pool is registered via
// the `cloudflareTest` Vite plugin (vitest 4 pool-rework migration).
export default defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
});
