# Deploying djibb to Cloudflare

djibb deploys as **two separate Cloudflare projects on two different
origins** — this split is load-bearing, not incidental:

| Project | Type | Origin | wrangler.toml |
|---|---|---|---|
| `djibb-server` | Worker | `https://api.djibb.com` | `packages/server-cf/wrangler.toml` |
| `djibb` | Pages (SvelteKit) | `https://djibb.com` | `apps/djibb-com/wrangler.toml` |

The frontend (`djibb.com`) calls the API (`api.djibb.com`) cross-origin.
That cross-origin boundary is what the Worker's CORS/CSRF middleware and
OAuth flow depend on: the frontend origin goes in `AUTHORIZED_DOMAINS`,
and `API_ORIGIN` is the Worker's own origin which is deliberately **not**
in that list (the magic-link self-POST is exempted by path instead). Do
not collapse these onto one origin.

The Worker owns the DurableObject (`DjibbList`) and the D1 binding
(`DJIBB_AUTH`); the Pages app only *references* the DO by
`script_name = "djibb-server"`. **Deploy order therefore matters: the
Worker must exist before Pages binds to its DO.**

---

## One-time setup (per environment)

1. **Custom domains** (Cloudflare dashboard — you own the `djibb.com`
   zone, so CF creates the DNS records):
   - Worker `djibb-server` → Settings → Domains & Routes → add
     `api.djibb.com`.
   - Pages `djibb` → Custom domains → add `djibb.com` (+ `www` if wanted).

2. **D1 database** — `djibb-auth`
   (`database_id f839093e-e2d9-4861-8a3f-05dca1d1a749`) is already
   provisioned. Apply migrations to the **remote** copy (local-only until
   the first prod deploy):
   ```sh
   cd packages/server-cf
   wrangler d1 migrations list  djibb-auth --remote   # confirm what's pending
   wrangler d1 migrations apply djibb-auth --remote
   ```

3. **Worker secrets** — these live as Cloudflare secrets/vars, never in
   `wrangler.toml` or git (mirror of `.dev.vars`). Without them the
   CORS/CSRF middleware throws and **every request 500s**:
   ```sh
   cd packages/server-cf
   wrangler secret put AUTHORIZED_DOMAINS      # https://djibb.com   (frontend origin; NOT api.djibb.com)
   wrangler secret put API_ORIGIN              # https://api.djibb.com
   wrangler secret put ENV                     # production
   wrangler secret put OAUTH_GOOGLE_CLIENT_ID
   wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET
   ```
   `EMAIL_FROM` is already set as a `[vars]` default in `wrangler.toml`
   (`no-reply@djibb.com`); override via secret only if it should differ.

4. **Google OAuth** — in Google Cloud Console → Credentials, register the
   authorized redirect URI against the API origin:
   ```
   https://api.djibb.com/auth/google/verify
   ```

5. **Pages env vars** (Pages dashboard → Settings → Environment
   variables, Production) — these are the build-time `VITE_*` values:
   ```
   VITE_DJIBB_ORIGIN = https://api.djibb.com   # one origin: fetch, sync, ws
   ```
   (`src/lib/config.js` derives the Replicache host and the `wss://` websocket
   origin from this — https here means the socket becomes `wss://`.)
   (Replicache no longer needs a license key — it's open source now, so
   there's no `VITE_REPLICACHE_LICENSE_KEY`.)

6. **Email domain** — verify `djibb.com` in Cloudflare Email so outbound
   invites / magic links actually deliver. The `send_email` binding sends
   for real only from a *deployed* Worker (local `wrangler dev` simulates
   sends — see the comment in `wrangler.toml`).

---

## Deploying

Always Worker first, then Pages.

```sh
# 1. API Worker (creates/updates djibb-server + the DjibbList DO namespace)
cd packages/server-cf
npm run deploy                # wrangler deploy

# 2. Frontend (binds to the DO above via script_name = "djibb-server")
cd ../../apps/djibb-com
npm run deploy                # vite build && wrangler pages deploy .svelte-kit/cloudflare
```

If you deploy Pages before the Worker exists, its `DJIBB_LIST` binding
resolves to a Worker that isn't there.

When schema changes ship, run the remote D1 migration (step 2 above)
*before* `wrangler deploy`.

---

## Pre-deploy gates (the always-green checklist)

Run from the repo root before deploying — same gates CI/local enforce:

```sh
npm --prefix packages/protocol  run typecheck
npm --prefix packages/client    run typecheck
npm --prefix packages/server-cf run typecheck
npm --prefix packages/server-cf run test         # needs wrangler login (remote EMAIL binding)
npm --prefix apps/djibb-com     run check        # expect: 0 errors
cd packages/server-cf && wrangler deploy --dry-run
node scripts/check-licenses.mjs                  # license matrix (ADR-0016)
```

---

## Sanity checks after deploy

- `curl https://api.djibb.com/` → `hello, djibb!` (Worker is up).
- Load `https://djibb.com`, sign in with Google (exercises the OAuth
  redirect → `api.djibb.com/auth/google/verify` round-trip).
- Trigger a magic-link / invite and confirm delivery (email domain).
- A 500 on *every* request almost always means a missing Worker secret
  (`AUTHORIZED_DOMAINS` first suspect); a `no such table` 500 means
  remote D1 migrations weren't applied.
