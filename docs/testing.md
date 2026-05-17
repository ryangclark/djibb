# Testing

Conventions and patterns for adding tests in this codebase. Read this
before writing a new test — most surprises have already been hit.

## The two test surfaces

| Surface | Lives in | Driven by | Covers |
| --- | --- | --- | --- |
| **Service / unit** | `workers/test/` | vitest + `vitest-pool-workers` | Pure functions, D1 SQL contracts, durable-object handlers exercised at the service-function level, business logic in isolation. |
| **End-to-end** | `e2e/` | bash + [`agent-browser`](https://github.com/anthropics/agent-browser) CLI | Wiring between worker + pages + browser. Cross-origin redirects, real cookies, JS actually executing on a real DOM. |

Default to service-level when the behavior can be exercised that way. E2E
is for things that genuinely require the full stack: redirect chains,
cookie-backed session resolution, mid-form JavaScript, multi-session
collaboration. The two surfaces complement each other — the load-bearing
security claims live in the service tests; the E2E tests verify that
the wiring around those claims is correct.

## Service-level tests (`workers/test/`)

### Conventions

```ts
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

beforeAll(async () => { await ensureD1Schema(); });
beforeEach(async () => { await resetWorkspaceData(); });

describe('your-thing', () => {
    it('does the thing', async () => {
        // Direct service calls — not HTTP.
        const result = await yourFunction(env.DJIBB_AUTH, ...);
        expect(result).toEqual(...);
    });
});
```

- `ensureD1Schema` applies all migrations to the test D1. Idempotent.
- `resetWorkspaceData` truncates app tables between tests. Don't run a
  test that expects pre-existing rows.
- Most existing tests (see `invitation.test.ts`, `workspace.test.ts`)
  call **service functions directly**, not the Hono handlers. This is
  the preferred style: faster, more focused, and not subject to HTTP
  middleware quirks.

### Direct D1 staging for time-sensitive tests

When a test needs to control timestamps precisely (rate-limit windows,
expiry behavior, ordering), `INSERT` directly into D1 with the exact
`time_created` you want. Example from `magicLink.test.ts`:

```ts
async function insertToken(args: { ... }) {
    await env.DJIBB_AUTH.prepare(
        `INSERT INTO magic_link_tokens (...) VALUES (...);`
    ).bind(...).run();
}
```

Service functions that use `Date.now()` aren't usable for these tests
without faking the clock — direct INSERT is the cleaner alternative.

### HTTP-level tests (`worker.fetch`)

You **can** invoke the worker through its Hono app, but there's a
trap: synthetic `Request` objects in vitest-pool-workers cannot carry
a `Host` header (it's a forbidden header name in JS Fetch). The
production CSRF middleware (`workers/src/index.ts`) requires both
`Origin` AND `Host` to be present and trips a 403 otherwise. Real
browsers always send `Host`; tests can't.

**What this means in practice:**

- GET routes are unaffected (CSRF check skips GET) and can be tested
  via `worker.fetch` straightforwardly. See `test/first.test.ts`.
- POST/PUT/DELETE routes through the full middleware are *not*
  testable via `worker.fetch` without loosening production middleware,
  which we won't do for a test-only concern. Use one of:
  - **Service-level tests** for the route's underlying logic. This is
    almost always sufficient.
  - **Pure-predicate extraction** (see below) for security-sensitive
    branches you want exhaustively pinned.
  - **E2E** for the actual wired-up POST behavior through a real
    browser that sends a real Host header.

## End-to-end tests (`e2e/`)

See `e2e/README.md` for prerequisites (`agent-browser` installed, dev
servers running, ENV in `.dev.vars`, local D1 migrations applied).
Scripts are bash, exit non-zero on failure, idempotent across re-runs.

### Patterns that work

**Diagnostic-friendly preflight.** `curl -sf` exits silently under
`set -e`. For preflight assertions where you want to see what
*actually* came back on failure, capture the response body and status
separately:

```bash
probe_body_file="$(mktemp)"
probe_status="$(
    curl -s -o "$probe_body_file" -w '%{http_code}' \
        -X POST "$URL" -H 'Content-Type: application/json' -d "$body"
)"
probe_response="$(cat "$probe_body_file")"
rm -f "$probe_body_file"

if [[ "$probe_status" != "200" ]]; then
    fail "got HTTP ${probe_status}. body: ${probe_response}"
fi
```

**Semantic locators over snapshot grepping.** agent-browser's snapshot
output format is `[type] "label" [ref=eN]` — the `eN` ref refers to
elements via `@eN` in commands, but parsing it out of snapshot text is
brittle (the format varies by element type and ref numbers shift
across renders). Prefer:

```bash
ab find role button click --name "Sign me in"
ab find label "Email me a sign-in link" fill "$EMAIL"
ab find text "Loading…" wait
```

Accessibility-tree labels are stable across UI tweaks; `ref=eN` is not.

**Wait on destination *content*, not URL globs.** After a navigation
or redirect, prefer `wait --text "Expected heading"` over
`wait --url "**/path"`. URL-glob waiting has surfaced intermittent
"daemon busy" errors during cross-origin redirects in this codebase
(worker → pages, in particular). Content-waiting is the more reliable
signal anyway — it verifies both arrival AND that the destination
rendered.

**Retry helper for transient daemon errors.** Across cross-origin
navigations, agent-browser's daemon occasionally reports
`Resource temporarily unavailable (os error 35) (after 5 retries -
daemon may be busy or unresponsive)`. Retrying after a short delay
clears it in practice. Standard helper used in `e2e/rate-limit.sh`:

```bash
ab_retry() {
    local attempt
    for attempt in 1 2 3; do
        if ab "$@"; then return 0; fi
        (( attempt < 3 )) && sleep 1
    done
    return 1
}
```

**Idempotent setup.** Rate-limit and other state-accumulating tests
need a fresh slate. Drop the relevant table at script start (this is
fine because the dev D1 carries no value you'd mourn losing):

```bash
( cd "$(dirname "$0")/../workers" && \
  npx wrangler d1 execute DJIBB_AUTH --local \
      --command "DELETE FROM magic_link_tokens" > /dev/null 2>&1 )
```

**Different emails per phase.** When a script has multiple flows
hitting the same rate-limited surface, give each phase a distinct
email to avoid the 60-sec cooldown blocking phase 2 because phase 1
just minted a token. See `e2e/rate-limit.sh` for the pattern.

### Patterns to avoid

- **Parsing the snapshot output with grep**, especially regex against
  `\[ref=e[0-9]+\]` fragments. The format isn't stable; use semantic
  locators.
- **`wait --url` for cross-origin redirects.** Use `wait --text`
  instead.
- **`curl -sf` in preflight without capturing the body.** You'll get
  silent script exits with no diagnostic.
- **Assuming the dev D1 is clean.** It accumulates state across runs.
  Either reset at script start, or design phases to be isolated by
  random identifier.

## The dev-seam pattern

When an E2E flow needs to inspect or influence behavior that's
normally invisible to the client (a token that's only in an email, a
state that's only in the DB), add a **dev-mode test seam** to the
relevant handler rather than mocking out internals.

The shape (canonical example: magic-link in `workers/src/auth/magic.ts`):

1. **Caller opt-in:** add an optional boolean field to the request
   body (`_dev: true`).
2. **Environment gate:** check `c.env.ENV` (case-insensitive) is `dev`.
   Both conditions must hold.
3. **Conditional response:** return additional data only when the gate
   passes. Normal callers see the unchanged response.
4. **Loud logging:** log every time the seam fires so an accidental
   prod deploy with `ENV=dev` is visible in alerts.

The gate predicate itself should be a **pure function** so it can be
unit-tested exhaustively without HTTP machinery:

```ts
export function shouldExposeDevSeam(
    envValue: string | undefined | null,
    devFlag: boolean | undefined
): boolean {
    if (devFlag !== true) return false;
    if (envValue == null) return false;
    return String(envValue).toLowerCase() === 'dev';
}
```

Tests exhaust the matrix: every combination of env value (dev, DEV,
production, undefined, "" , near-misses like "develop") × dev flag
(true, false, missing). This is how the **production-safety claim** —
that an attacker adding `_dev: true` to a prod request cannot extract
seam output — gets pinned without needing HTTP fixtures.

## The pure-predicate pattern (more generally)

Whenever a handler has a branch whose correctness is security-sensitive
(authorization checks, env-gated behavior, validation that determines
whether sensitive data leaves the server), extract that branch as a
named pure function. Two payoffs:

- **Exhaustive testing without HTTP machinery.** All inputs, all
  outputs, fast.
- **Self-documenting code.** A named predicate (`shouldExposeDevSeam`,
  `canEdit`, `isInvitable`) reads at the call site; an inline ternary
  with the same logic does not.

See `workers/src/auth/resolver.ts` (`canRead`, `canEdit`) for an
existing example, and `workers/src/auth/magic.ts` (`shouldExposeDevSeam`)
for the test-seam variant.

## Operational gotchas

- **The local D1 is a separate beast from the vitest D1.** vitest
  applies migrations to its in-memory D1 via `ensureD1Schema`; the
  `wrangler dev` local D1 needs explicit `npx wrangler d1 migrations
  apply DJIBB_AUTH --local` after any new migration lands. If E2E
  scripts start failing with "table doesn't exist," check this.
- **`.dev.vars` carries `ENV="DEV"` (uppercase)** by historical
  convention; the codebase has been mixed about case-sensitivity.
  Any new ENV-gated check should use case-insensitive comparison
  (`String(env.ENV).toLowerCase() === 'dev'`). See `shouldExposeDevSeam`.
- **Cooldown clashes between scripts.** If two E2E scripts hit the
  same per-email or per-IP rate-limited surface back-to-back, the
  second can see unexpected 429s. Reset state at script start or
  use disjoint emails.
- **agent-browser sessions persist across invocations.** A session's
  cookies and tabs survive command-to-command. Use `--session
  <unique-per-test>` so concurrent or repeated test runs don't collide.

## When you're about to add a new test

1. Can the behavior be exercised at the service level? → vitest in
   `workers/test/`.
2. Does it involve a security-sensitive branch? → extract as a pure
   predicate, exhaust the matrix.
3. Does it require real-browser execution (form submission, cookie
   redirect, multi-tab sync)? → agent-browser script in `e2e/`.
4. Does it need access to data the client doesn't normally see? →
   consider a dev seam before reaching for mocks.

When in doubt, the existing tests are the canonical examples:
`magicLink.test.ts` (matrix-style unit), `invitation.test.ts`
(service-level integration), `magic-link.sh` (happy-path E2E),
`rate-limit.sh` (multi-phase E2E with state reset).
