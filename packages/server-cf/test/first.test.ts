import {
    env,
    createExecutionContext,
    waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import worker from '../src/index';

describe('hello djibb', async t => {
    it('responds with hello djibb!', async () => {
        // The base URL doesn't actually matter because we always
        // pipe it to the worker via `worker.fetch()`.
        const request = new Request('https://djibb.com/');

        // Create an empty context to pass to `worker.fetch()`
        const ctx = createExecutionContext();

        const response = await worker.fetch(request, env, ctx);

        // Wait for all `Promise`s passed to `ctx.waitUntil()`
        // to settle before running test assertions
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('hello, djibb!');
    });
});
