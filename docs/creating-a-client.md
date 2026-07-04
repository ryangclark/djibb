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

- [ ] Mint a token via the `issued_credentials` flow (seed-operator
  mints today; a self-serve mint UX is a known TODO of ADR 0022).
  Give it an honest `label` — that label *is* the client's identity in
  the management surface.
- [ ] Send `Authorization: Bearer <token>`; see `djibbRequestHeaders`
  in `packages/server-cf/bin/djibb.ts`.
- [ ] For entity-scoped clients (an email-reply token, a
  single-exchange bot), set `bound_entity_id` so a leaked token can't
  roam.

**Either way:**

- [ ] **Add the client's origin to the worker's `AUTHORIZED_DOMAINS`**
  (`;`-separated env var) for every environment, including
  `packages/server-cf/.dev.vars` locally. A missing entry doesn't fail
  politely — it 500s every request.

## Step 3 — Entity sync (reads and writes)

- [ ] Construct the Replicache client with
  `createReplicacheClient({ accountId, listId, baseUrl, secure })`
  from `@djibb/client/replicache`. The package never reads env — your
  app injects `baseUrl` (see `apps/djibb-com/.env.example` /
  `VITE_API_BASE_URL` for the pattern).
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
- [ ] **⚠ gap — the shared transport is cookie-only.**
  `makePusher`/`makePuller` in `@djibb/client` hardcode
  `credentials: 'include'` and can't send a Bearer header; the CLI
  hand-rolls its own push/pull for this reason. A non-cookie
  Replicache client is the second consumer that forces
  auth-parameterizing the transport (tracked intent in ADR 0014's
  extraction rule).
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

1. **Read authorization is incomplete** (ADR 0021). View-floor reads
   and accept-to-view are decided but the read-authz hole is not fully
   closed. Any client whose premise is *secrecy* — Secret Santa being
   the flagship case: giftees must not see claims on their own list —
   is blocked on finishing this, and likely needs more: today's roles
   gate whole entities, and "hide these *items* (or this field) from
   the owner" is item-level visibility the lattice doesn't express.
   Conditional subtrees (ADR 0019) may be the seed of an answer;
   otherwise this is a new ADR before that client is honest.
2. **The interactive credential mint (ADR 0024, Proposed) isn't built
   yet — and it's the linchpin of the scattered-clients vision.**
   Off-domain clients can't ride the cookie; the designated shape is a
   connect ceremony (authorization code + PKCE over the existing
   interactive flows) that ends by minting an `issued_credentials` row
   and handing the token back. The worker already implements the front
   half (`referer_origin` + redirect-back); the token endpoint, the
   disclosure interstitial, and Bearer support in the `@djibb/client`
   transport are the build. Branded ("Sign in with djibb") vs
   white-label is a per-client product choice over the same machinery
   — but the connection-moment disclosure on the worker's own surface
   is mandatory either way (ADR 0024 §3).
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
