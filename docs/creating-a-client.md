# Creating a new client

Checklist for standing up a new djibb client from scratch. A *client* is
anything that speaks the djibb protocol (ADR 0022): djibb.com, the
`djibb` CLI, and — planned — email, Secret Santa, and voice clients.
Clients are *supposed* to be weird; the protocol keeps the weirdness
cheap by prescribing only two things: a request **authenticates to an
Account** (or is anonymous), and that Account **resolves to a role per
entity** (ADR 0021). Everything above that line is yours.

This doc is partly aspirational. Steps marked **⚠ gap** describe things
a new client needs that don't exist yet (or exist only inside an
existing client and need extracting). Building a client is expected to
close some of these gaps — that's the "second consumer" rule from ADR
0014: shared code is extracted when the second consumer appears, not
before.

## The shape in three sentences

A client talks to the one Cloudflare backend (`packages/server-cf/`)
through the protocol package (`@djibb/protocol`): entity schemas, the
ID scheme, the mutator contract, and the markdown/JSON encodings. Reads
and writes to an entity go through Replicache push/pull against that
entity's Durable Object, with a websocket poke telling you when to
pull (ADRs 0003, 0006); non-entity operations (auth, invitations,
account settings) are plain HTTP endpoints on the worker. `@djibb/client`
holds the framework-agnostic Replicache wiring so you don't rebuild the
transport.

## Step 0 — Decide what kind of client this is

Answer these before writing code; they determine everything below.

1. **Whose Account does it act as?** (ADR 0022 §3) A tool a person uses
   (browser, CLI, email-reply) operates *that person's* Account. A
   standing actor with no single human behind it (a bot, a shared
   automation) gets **its own Account** and is shared into entities via
   the normal roster. This is a setup-time decision recorded on the
   credential, never inferred per request.
2. **Interactive or non-interactive auth?**
   - *Interactive* (a human signs in): OAuth / magic-link mint a
     multi-account session, ridden as the `djibb-session` cookie
     (ADR 0010).
   - *Non-interactive*: a pre-issued bearer token from
     `issued_credentials`, sent as `Authorization: Bearer` (ADR 0022).
     A new client is a new `label` on a credential row — never a new
     credential type, never new permissions.
3. **What's the auth floor?** Clients may set different floors (the
   CLI's `contribute` is anonymous-by-design; djibb.com supports
   anonymous lists). Anonymous requests resolve to the entity's
   `default_role`.
4. **Full-duplex or fire-and-forget?** A live UI wants
   Replicache + websocket pokes. A one-shot surface (CLI verb, email
   reply) can push a single mutation with a fresh `clientID` and never
   pull — see `pushMutation` in `packages/server-cf/bin/djibb.ts` for
   the pattern.

## Step 1 — Workspace scaffolding

- [ ] New workspace under `apps/<name>/` (webapps) — the root
  `package.json` workspaces glob already covers `apps/*` and
  `packages/*`.
- [ ] Depend on `@djibb/protocol` and (for Replicache clients)
  `@djibb/client` via `"*"` workspace refs.
- [ ] **License:** shared packages are Apache-2.0; the djibb.com app is
  PolyForm Shield (ADR 0016). Decide per client and set `license` in
  its `package.json`; run `npm run licenses:check`.
- [ ] Add a row to the Clients table in `CONTEXT-MAP.md`. A per-client
  `CONTEXT.md` is created lazily by `/domain-modeling` once the client
  has real terms of its own — don't stub it upfront.
- [ ] Client-specific decisions (its auth floor, its interaction model)
  live in the client's context, not in root `docs/adr/`. Only changes
  that ripple through the protocol go in the shared ADR log.

## Step 2 — Authentication wiring

All clients funnel into the single request→Account seam on the worker;
you only choose how the credential *arrives*.

**Cookie path (interactive webapps):**

- [ ] Drive the existing worker auth endpoints: `/auth/google/verify`
  (OAuth) and `/auth/magic/request` (magic link — the emailed link
  lands on a worker interstitial; the frontend never holds a raw
  token). See `apps/djibb-com/src/lib/api/magicLink.js`.
- [ ] Send `credentials: 'include'` on every fetch (the `@djibb/client`
  pusher/puller already do).
- [ ] Sessions are **multi-account**: non-Replicache API calls that act
  as an account must pin it with the `X-Djibb-Active-Account` header
  (see `apps/djibb-com/src/lib/entities.js`).
- [ ] **⚠ gap — cookie is same-site only, and same-site is the
  exception, not the rule.** `djibb-session` is `SameSite=Lax`
  (`packages/server-cf/src/auth/constants.ts`), so cookie auth only
  works for clients hosted same-site with the API (`*.djibb.com`).
  The project's posture is that clients live on their own domains,
  scattered — people should be able to use the protocol without ever
  knowing djibb.com exists. So the cookie path is the djibb.com-family
  special case; the designated path for everyone else is the
  interactive credential mint below.

**Bearer path (CLIs, bots, integrations):**

- [ ] Get a token. Two ways in: `seed-operator` mints one directly (the
  operator/first-party path — CI, the `djibb` CLI), or an interactive user
  runs the **connect ceremony** below, which *is* the self-serve mint ADR
  0022 deferred (ADR 0024, now built). Either way you end up with an
  ordinary `issued_credentials` row. Give it an honest `label` — that label
  *is* the client's identity in the management surface.
- [ ] Send `Authorization: Bearer <token>` — build the transport with
  `bearerToken(token, { origin })` from `@djibb/client/transport`, which
  attaches it and the `Origin` header for you. (`anonymous({ origin })`
  is the no-credential variant; `sessionCookie()` is the browser's.)
- [ ] For entity-scoped clients (an email-reply token, a
  single-exchange bot), set `bound_entity_id` so a leaked token can't
  roam.

**Connect-ceremony path (off-domain interactive sign-in) — the client-integration contract:**

This is the designated path for a client on its own domain whose user signs
in *themselves* (ADR 0024). It reuses the interactive flows (OAuth /
magic-link) but terminates by minting a **Bearer credential** instead of the
same-site cookie the browser can't send cross-site. The ceremony imposes a
concrete contract on the client — these are obligations the *substrate*
requires, distinct from the one operator setup step (`AUTHORIZED_DOMAINS`,
below). As of ADR 0024 items 1–3 (#28, #29, #59) the whole path works
end-to-end; item 4 (the first real off-domain consumer) will stress it.

- [ ] **Host an `/accounts/verified` redirect target that reads `?code=`.**
  On success the worker redirects the browser back to
  `<your-origin>/accounts/verified?code=<authorization_code>`. There is **no
  error/decline callback**: per the #29 v1 amendment the consent page has no
  decline button, so a user who doesn't connect simply never returns. Your
  client must therefore tolerate the ceremony **never completing** (a
  timeout / abandoned tab), not wait for an error redirect that never comes.
- [ ] **Generate a PKCE verifier + `S256` challenge, and hold the verifier
  across the redirect.** Only the verifier proves possession at exchange;
  `plain` is rejected. (`randomString(43)` from `@djibb/protocol/id` is a
  PKCE-legal verifier; the challenge is `base64url(SHA-256(verifier))`.)
- [ ] **Start the ceremony carrying origin + challenge + label.** OAuth:
  `GET /auth/google?connect=1&code_challenge=<challenge>&label=<label>`
  (origin comes from the validated `Referer`). Magic-link: `POST
  /auth/magic/request` with `connect: { origin, code_challenge, label }`.
- [ ] **Exchange `code` + `code_verifier` at `POST /auth/connect/token`** and
  store the returned bearer token. It's returned exactly once — the raw
  token is never persisted server-side.
- [ ] **Then send `Authorization: Bearer` on every API call**, via
  `bearerToken(token, { origin })` — including the Replicache sync loop,
  which now carries the credential too (`createReplicacheClient({ …,
  credential })`, #59). Nothing above the transport line changes.
- [ ] **Re-run the ceremony on expiry.** Tokens are ~90-day and
  **non-refreshable by design** — re-connecting *is* the refresh (cheap by
  intent; a memory-only token that reconnects per visit is a legitimate
  posture, ADR 0024 §6). Treat a 401/403 as "reconnect," not "error out."

**Either way:**

- [ ] **Add the client's origin to the worker's `AUTHORIZED_DOMAINS`**
  (`;`-separated env var) for every environment, including
  `packages/server-cf/.dev.vars` locally. A missing entry doesn't fail
  politely — it 500s every request.

## Step 3 — Entity sync (reads and writes)

- [ ] Construct the Replicache client with
  `createReplicacheClient({ accountId, listId, baseUrl, secure, credential })`
  from `@djibb/client/replicache`. `credential` defaults to `sessionCookie()`
  (the browser/same-site case); pass `bearerToken(token, { origin })` for an
  off-domain client (#59). The package never reads env — your
  app injects `baseUrl`. djibb-com resolves it in `src/lib/config.js` from
  a single `VITE_DJIBB_ORIGIN` (see `apps/djibb-com/.env.example`), which
  also feeds `@djibb/client/transport` for plain fetch.
- [ ] Wrap mutations with `wrapMutators` so call sites pass body args
  only; the envelope (`accountId`, `timestamp_client`) is injected for
  you.
- [ ] Open the poke websocket per entity, carrying the Replicache
  `clientID` as `?c=` so the DO can unicast per-mutation outcomes back
  to you (ADR 0006). Untagged sockets still get `poke` broadcasts.
- [ ] **⚠ gap — the websocket helper is not in `@djibb/client`.**
  djibb-com's `src/lib/websocket.js` (30 lines, partysocket) is the
  only implementation. Second consumer ⇒ extract it, including the
  `entityPath` routing it duplicates.
- [ ] **Writing without a Replicache instance?** Use
  `pushMutation`/`pullEntity` from `@djibb/client/oneshot`. The DO's mutator
  pipeline is the only write door (ADR 0003), so a one-shot writer speaks the
  push protocol too — these build the envelope for you. **Mint the identity
  once per logical mutation** with `newOneShotClient()` and reuse it across
  retries: `(clientID, mutationID)` *is* the idempotency key, and re-minting
  per attempt makes a retried push apply twice. (The inverse misuse — reusing
  one client for a *different* mutation — would be silently skip-and-acked by
  the DO, so `pushMutation` throws on it.) `djibb contribute`/`promote`
  are the reference consumers.
- [ ] **`makePusher`/`makePuller` carry the caller's credential** (cookie or
  Bearer), so a *real* (long-lived, syncing) Replicache client authenticates
  off-domain, not only a one-shot push. The credential threads in through
  `createReplicacheClient`'s `credential` param above (defaulting to the
  session cookie); this was the last piece of ADR 0024 item 3 (#59, closing
  the arch-review #5 transport work).
- [ ] Respect `schemaVersion` (currently `'1'` in
  `createReplicacheClient`). It's a **cross-client contract**: when
  stored value shapes change, every client must bump together.
  **⚠ gap:** the version lives inline in `@djibb/client` rather than
  as a named protocol constant — fine while all Replicache clients go
  through the one factory, worth hoisting to `@djibb/protocol` the
  moment one doesn't.
- [ ] Undo, if your interaction model wants it: the framework-agnostic
  stack is `@djibb/client/undoStack` (inverse mutators, ADR 0005);
  the Svelte-flavored `withUndo` stays in djibb-com and is a template,
  not a dependency.

## Step 4 — Account-level surface ("my lists")

- [ ] The per-account entity index is today a plain HTTP read:
  `GET /entities` with `credentials: 'include'` and the
  `X-Djibb-Active-Account` header (see
  `apps/djibb-com/src/lib/entities.js`), served off the D1-derived
  index (ADR 0003). ADR 0013's thin Account DO (Replicache sync for
  the account surface) is the decided direction — when it lands,
  clients move from fetch-on-load to the same push/pull machinery.
- [ ] Invitations are DO-resident and tokenless (ADR 0009); accept is
  an in-app act. If your client's users need to *receive* shares, you
  need UI for pending invites (djibb-com's
  `src/lib/api/invitations.js` + `InviteBanner.svelte` are the
  reference).
- [ ] Creating entities: mint IDs client-side with `@djibb/protocol/id`
  and `initList`. Note `initList` is terminal-marked territory —
  read `docs/adding-a-mutator.md` before touching mutator flows.

## Step 5 — The client's actual weirdness

This is the point. djibb.com forbids verbatim template copying; the CLI
speaks in operator recipes; an email client's whole interaction model is
a reply. Whatever your client's constraint or superpower is, implement
it **above** the protocol line: never new permissions, never a new
credential type, never a client-specific mutator gate. If the weirdness
seems to need one of those, it's actually a protocol change — write the
ADR first.

## Step 6 — Ship checklist

- [ ] `npm run typecheck` in the workspace; wire it into whatever the
  client's check verb is (djibb-com uses `npm run check`).
- [ ] Deploy config: webapps deploy as their own Cloudflare Pages
  project (see `docs/DEPLOY.md`); the worker is shared, so a new
  client usually ships **without touching the backend** except
  `AUTHORIZED_DOMAINS`.
- [ ] Local dev: `wrangler d1 migrations apply djibb-auth --local`
  before first run, and populate `packages/server-cf/.dev.vars` — a
  missing `AUTHORIZED_DOMAINS` or an unmigrated D1 both surface as
  opaque 500s.
- [ ] E2E: `e2e/` at the root holds shell-script journeys against a
  local worker; add at least one that exercises the client's auth
  path.

## Known protocol-level gaps a client may hit

Gaps above are extraction chores; these are design work.

1. **Item-level read secrecy doesn't exist** (ADR 0021). Entity-level
   view-floor reads are enforced (GH #13), but roles gate *whole
   entities*: any client whose premise is secrecy — Secret Santa being
   the flagship case: giftees must not see claims on their own list —
   needs "hide these *items* (or this field) from a specific member,"
   which the role lattice doesn't express. Conditional subtrees
   (ADR 0019) may be the seed of an answer; otherwise this is a new
   ADR before that client is honest.
2. **The interactive credential mint (ADR 0024) is built** — items 1–3
   landed (token endpoint + PKCE #28, disclosure interstitial #29, Bearer
   transport #59). Off-domain clients can't ride the cookie, so they run the
   connect ceremony (authorization code + PKCE over the existing interactive
   flows) which ends by minting an `issued_credentials` row and handing the
   token back — see the client-integration contract in Step 2. What remains
   is **item 4**: the first real off-domain consumer (Secret Santa) walking
   the whole path, which is expected to surface real-world gaps — and it is
   itself blocked on gap #1 (item-level read secrecy). Branded ("Sign in
   with djibb") vs white-label is a per-client product choice over the same
   machinery, but the connection-moment disclosure on the worker's own
   surface is mandatory either way (ADR 0024 §3).
3. **Third-party (stranger-built) clients are gated** on two decisions
   ADR 0024 §5 names but defers: per-credential role narrowing
   (`role_ceiling` or equivalent — a stranger's client holding your
   full resolved role everywhere is too big a grant) and a
   registration stance (self-serve registration vs. a deliberate open
   ecosystem). First-party off-domain clients need neither; they ride
   the operator allowlist.
4. **No client scaffold.** Once the second webapp exists, consider a
   starter app (or extract Step 1–3 into a documented copy-me) so the
   boilerplate is copy rather than archaeology.
