import { env } from 'cloudflare:test';

// Point the `EMAIL` binding at a no-op for the whole test run.
//
// In production `EMAIL` is a Cloudflare `send_email` binding; under
// miniflare it's backed by a domain-validating sender that REJECTS any
// real send ("email from djibb.app not allowed because domain was not
// found"). That rejection surfaces on a detached RPC-proxy promise, so a
// caller's `try/catch` around `await env.EMAIL.send(...)` can't swallow
// it — it lands as an "Uncaught (in promise)" and fails whichever
// unrelated test happens to be running (pool-workers shares one `env`
// across files, so the failure is cross-file and flaky).
//
// Tests that assert email behavior install their own capturing spy over
// this and restore back to it — so the real binding is never the
// `env.EMAIL` they save/restore. Keeping the baseline a no-op means even
// a cross-file spy-restore race can only ever swap between no-op and a
// capturing spy, never the real (rejecting) binding.
(env as { EMAIL: unknown }).EMAIL = {
    send: async () => {},
};
