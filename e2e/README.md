# /e2e — browser-driven end-to-end tests

End-to-end scripts that exercise the running app through a real browser via
[`agent-browser`](https://github.com/anthropics/agent-browser). These tests
complement the unit/service tests in `workers/test/` by covering the wiring
between the worker, the SvelteKit pages, and the browser surface — pieces
that the in-process vitest suite can't reach (Host headers, real cookies,
real redirects, JavaScript actually executing on a real DOM).

**Before writing a new test (here or in `workers/test/`), read
[`/docs/testing.md`](../docs/testing.md).** It captures the conventions
for both surfaces, the dev-seam pattern that lets E2E scripts inspect
otherwise-invisible server state, and the gotchas (cross-origin redirect
waits, idempotent state reset, semantic locators) that took iteration
to discover.

This directory is exploratory infrastructure. The first script
(`magic-link.sh`) is the proof of pattern; if it earns its keep, more
scripts will land alongside it for the share/invite, OAuth, and
workspace-management flows.

## Prerequisites

1. **`agent-browser` installed.** One-time setup:
   ```bash
   npm install -g agent-browser
   agent-browser install   # bootstraps Chromium
   ```
   The scripts use the CLI directly; nothing is bundled in this repo.

2. **Two dev servers running**, in separate terminals:
   ```bash
   cd workers && npm run dev   # wrangler dev, defaults to :8787
   cd pages && npm run dev     # vite dev, defaults to :5173
   ```

3. **`workers/.dev.vars`** contains an `ENV` variable whose value
   (case-insensitive) is `dev`. The dev-mode test seam in
   `/auth/magic/request` (ADR 0010 supplement) is gated on this. The
   seam refuses to fire in any non-dev environment regardless of
   request flags — see `shouldExposeDevSeam` and its unit tests.

4. **Local D1 migrations applied.** The vitest suite manages its own
   D1 schema; `wrangler dev` does not. Apply manually after any new
   migration:
   ```bash
   cd workers && npx wrangler d1 migrations apply DJIBB_AUTH --local
   ```

5. **Optional but recommended:** a clean local D1. The scripts use
   randomized email addresses so reruns don't collide, but a fresh DB
   makes failures easier to read.

## Running

Each script is a self-contained bash file that exits non-zero on the
first assertion failure. Run from the repo root:

```bash
bash e2e/magic-link.sh
```

Scripts pause via `agent-browser snapshot` between steps. To watch the
browser as it runs, prepend `AGENT_BROWSER_HEADED=1`:

```bash
AGENT_BROWSER_HEADED=1 bash e2e/magic-link.sh
```

## What's covered

| Script                | Flow                                            |
|---                    |---                                              |
| `magic-link.sh`       | Sign in to a fresh email via magic link, land on /workspaces, confirm Account row appears on /accounts |
| `rate-limit.sh`       | Magic-link rate-limit guard: server returns 429+`reason` on rapid resend; client form shows "Resend in Ns" countdown |
| `entity-invite.sh`    | Two-session ADR 0009 invitation flow: inviter creates a list, sends an email invite; invitee signs in via magic link, lands on `/l/<id>?from_invite=1`, accepts; invitee can view the list, inviter's pending-invite drains in real time. |
| `example-list.sh`     | Homepage example List: the read-only Seed Pool Blank renders, mint-on-engage forks it into an owned List (toggle preserved), and "+ New list" creates a fresh List via the `?new=1` marker — all with no doomed `initList` push-403 in the console. Skips phase A if the local Seed Pool holds no Blank. |

## Knowingly out of scope

- **CI integration.** The scripts assume dev servers are already up.
  Wiring them into CI requires either a docker-compose, a wrangler/vite
  startup orchestrator, or staging deployment — separate effort.
- **Real email delivery.** The dev seam (`_dev: true` in
  `/auth/magic/request`) lets the script grab the landing URL without
  going through the inbox. A staging-environment E2E using Cloudflare
  Email Workers + `postal-mime` to parse real incoming mail is the
  natural follow-up if/when that environment exists.
Note: the "knowingly out of scope: cross-account / multi-session" entry
that used to live here landed with `entity-invite.sh` — two
`--session` flags (inviter + invitee) isolate cookies and Replicache
state. The same pattern applies to future cross-account scripts; see
that script for the helper shape (`ab_inviter` / `ab_invitee`
wrappers).
