# What a brand-new off-domain client hits, end to end

Research for GH #80 (map: #76). Question: walk `docs/creating-a-client.md`
against the code as if standing up the Secret Santa client today, and list
every real obstacle, classified **BLOCKER** (needs core work),
**EXTRACTION CHORE** (move or write shared client code), or **DOC FIX**.

Assumed client: a standalone browser webapp on its own domain (not
`*.djibb.com`), users sign in through the ADR 0024 connect ceremony, the app
holds a Bearer token, and it opens many entities at once per user (a wishlist
plus hidden companion entities, across about ten people).

Code state: `main` at `46b78d844`. Paths are repo-relative.

## How to read the evidence tags

- **[code]** read at the cited `file:line`. Nothing here was executed: no
  test run, no browser session, no local worker.
- **[prod]** one live `OPTIONS` preflight sent to `https://api.djibb.com`
  (finding B4).
- **[inferred]** follows from the code plus browser or platform behaviour I
  did not test. Each one says what would confirm it.

## Answer in brief

The working belief "nothing blocks a new client" holds for the sync core and
does not hold for the edges around it.

What works with a Bearer credential from an off-domain browser, as far as the
code shows: creating entities, push and pull, `GET /entities`, "shared with
me", the pending-invitation inbox, sending and accepting invitations, and
changing authorization rules. None of these need the session cookie or
`X-Djibb-Active-Account`.

What does not work as the client needs it:

1. Invitation emails send the invitee to djibb.com, not to the client (B1).
2. Browser websockets cannot carry the Bearer token, so they connect
   anonymously and share a 60-per-minute per-IP limit (B2).
3. The magic-link ceremony cannot finish on a different device or browser
   than the one that started it, and its email never names the client (B3).
4. Two request headers `@djibb/client` sends are not allowed by CORS (B4).

B1 is a hard blocker for an invite-by-email joining flow. B2 to B4 are
shippable with the workarounds given, at a cost to the quality bar in #76.

## Classified list

| # | Class | Finding |
|---|---|---|
| B1 | BLOCKER (hard) | Invitation and other notification emails link to the first `AUTHORIZED_DOMAINS` origin (djibb.com) and are djibb-branded |
| B2 | BLOCKER (soft) | Off-domain websockets are unauthenticated and share the anonymous per-IP rate limit |
| B3 | BLOCKER (soft) | Magic-link connect dead-ends across devices or browsers; email and landing page say only "Sign in to djibb" |
| B4 | BLOCKER (soft, one-line fix) | CORS `allowHeaders` omits `X-Djibb-Active-Account` and `X-Djibb-Push-Outcomes` |
| E1 | EXTRACTION CHORE | No client-side connect-ceremony code exists anywhere |
| E2 | EXTRACTION CHORE | Websocket poke helper and its message loop live only in djibb-com |
| E3 | EXTRACTION CHORE | No multi-entity manager; djibb-com's Replicache shell is Svelte and single-entity |
| E4 | EXTRACTION CHORE | `npm start` runs only the worker plus djibb-com |
| E5 | EXTRACTION CHORE | No end-to-end journey covers the connect ceremony |
| D1 | DOC FIX | "Known gaps" #1 and #2 predate ADR 0027 |
| D2 | DOC FIX | "A missing `AUTHORIZED_DOMAINS` entry 500s every request" is no longer true |
| D3 | DOC FIX | `AUTHORIZED_DOMAINS` order and exact form are load-bearing and undocumented |
| D4 | DOC FIX | "Treat a 401/403 as reconnect" misses that an expired token never 401s a pull |
| D5 | DOC FIX | The token response has no expiry, and there is no sign-out or self-revoke route |
| D6 | DOC FIX | `bearerToken(token, { origin })` cannot set `Origin` in a browser |
| D7 | DOC FIX | Step 4 says `GET /entities` needs the cookie and active-account header; a Bearer client needs neither |
| D8 | DOC FIX | Step 0 points `pushMutation` at the CLI file; it lives in `@djibb/client/oneshot`, which is not browser-usable today |
| D9 | DOC FIX | "Decide the licence per client" contradicts the licence gate |
| D10 | DOC FIX | `schemaVersion` gap note is stale; "no polling" comment is wrong |
| D11 | DOC FIX | Bearer clients cannot run terminal mutators (`transferOwnership`) |
| D12 | DOC FIX | Ceremony contract omits where to hold the verifier, the Referer requirement, and local-dev cookie behaviour |
| D13 | DOC FIX | The entity index is account-wide across clients, with no client tag |

## Blockers

### B1. Invitation emails send people to djibb.com (hard)

- Every outbound link is built on the first entry of `AUTHORIZED_DOMAINS`:
  `packages/server-cf/src/list/notifications.ts:96-97`. [code]
- The invitation accept link is `<that origin>/l/<suffix>?from_invite=1`:
  `notifications.ts:104-135`, `:188`. [code]
- The email is sent for every committed `inviteByIdentity`, with no argument
  to suppress or redirect it: `notifications.ts:152-211`;
  `packages/protocol/src/list/mutators/inviteByIdentity.ts:45-50` (the args
  are `listId`, `identity_kind`, `identity_value`, `role` only). [code]
- Subject and body are fixed djibb copy, "X shared Y with you on djibb", from
  "djibb invites": `packages/server-cf/src/email/index.ts:46-70`. [code]
- The archive notice links to `<that origin>/trash` the same way:
  `notifications.ts:424-428`. [code]

Effect: an organiser who invites a family member from the Secret Santa app
causes an email that opens the wishlist (or a companion entity) as a plain
list in the generic djibb.com client. The invitee never reaches the Secret
Santa app from that email.

There is no client-side workaround that avoids the email while still inviting
someone who has no account yet. `changeMemberRole` adds a member directly with
no email (`packages/protocol/src/list/mutators/changeMemberRole.ts:20-25`),
and so does `setListAuthRules`, but both need the target's account id, which
does not exist before first sign-in.

Volume note [inferred]: invitations are per entity. If each giver is invited
separately to nine wishlists and nine companion entities, that is 18 emails
and 18 accepts per person. Invitations expire after 7 days
(`packages/protocol/src/list/invitations.ts:29`). Direct adds via
`changeMemberRole` once account ids are known avoid both.

### B2. Off-domain websockets are anonymous and rate-limited per IP (soft)

How the socket is authorized:

- Browsers cannot set `Authorization` on a `WebSocket`, and the worker reads
  a Bearer token only from that header:
  `packages/server-cf/src/auth/middleware.ts:46-52`. There is no query-param
  or first-message token path. [code]
- The session cookie is `SameSite=Lax`
  (`packages/server-cf/src/auth/constants.ts:22`), so a cross-site handshake
  does not send it. [code for the attribute; inferred for browser behaviour]
- So an off-domain socket resolves to the `anonymous` principal
  (`packages/server-cf/src/auth/principal.ts:107-142`). [code]
- That is accepted. The upgrade route has no role gate and forwards straight
  to the Durable Object: `packages/server-cf/src/list/fetch.ts:574-595`. The
  DO checks only the upgrade headers and tags the socket with `?c=`:
  `packages/server-cf/src/list/durable_object.ts:1675-1765`. CORS and CSRF
  are both skipped for websocket paths: `packages/server-cf/src/index.ts:102`,
  `:125-128`. [code]
- Pokes carry no content, and per-mutation outcomes are unicast by client id
  (`durable_object.ts:2391-2425`), so an anonymous socket still does its job.
  [code]

So the socket works off-domain. The obstacle is the rate limit:

- `/push` and `/websocket` are throttled; an anonymous principal is charged
  against `RL_ANON_WRITE`, keyed by IP: `list/fetch.ts:135-164`. [code]
- `RL_ANON_WRITE` is 60 per 60 seconds; the authenticated bucket is 600:
  `packages/server-cf/wrangler.toml:39-47`. [code]
- The test suite asserts the websocket upgrade is throttled on that bucket:
  `packages/server-cf/test/rateLimit.test.ts:250-260`. [code]
- The shared-IP weakness is acknowledged for anonymous traffic:
  `packages/server-cf/src/utils/rateLimit.ts:36-42`. [code]

Arithmetic [inferred]: one user opening a wishlist plus a companion entity
for each of ten people, plus a group entity, opens about 21 sockets on page
load. Three people on one home network loading within a minute exceed 60.
Refused upgrades return 429, and a reconnecting socket library retries, which
keeps charging the same bucket. The client's pushes are unaffected, because
they carry the Bearer token and use the 600 bucket.

Why this is soft: Replicache polls anyway. `createReplicacheClient` does not
set `pullInterval` (`packages/client/src/replicache.js:62-81`), and the
installed Replicache 15.3.0 defaults it to 60 seconds
(`node_modules/replicache/out/chunk-B3SOU6MT.js`, `pullInterval:d=6e4`).
`/pull` is not throttled (`list/fetch.ts:126-131`). A client with no working
sockets converges within a minute. The cost is a wider double-buy window.

Workarounds without core work: open sockets only for the entities on screen,
and rely on the poll for the rest.

### B3. Magic-link connect cannot finish on another device (soft)

- The client keeps the PKCE verifier; the server only ever stores the
  challenge: `packages/server-cf/src/auth/magic.ts:120-126`, `:416-418`.
  [code]
- The emailed link works on any device. After consent the worker redirects
  the browser that clicked Connect to `<origin>/accounts/verified?code=`:
  `packages/server-cf/src/auth/connect.ts:636-638`. [code]
- The exchange needs the verifier: `connect.ts:234-237`, `:283-291`. A wrong
  or absent verifier spends the code and returns `invalid_grant`. [code]

Effect [inferred]: a user who types their email on a laptop and opens the
message on a phone lands on the client's `/accounts/verified` page on the
phone, which has no verifier. Sign-in fails on both devices. The same happens
when a mail app opens the link in an in-app browser with separate storage.
ADR 0024 says the magic-link context "survives the cross-device email hop"
(`docs/adr/0024-off-domain-client-sign-in-interactive-credential-mint.md:277`);
that is true of the server-side context and not of the exchange.
Confirm by running the ceremony across two browsers.

Copy, same flow:

- The email subject and body are "Sign in to djibb" from "djibb sign-in",
  with no mention of the client: `email/index.ts:334-358`. The connect label
  is on the token row but is not passed to the email: `magic.ts:416-418`,
  `:992-1003`. [code]
- The landing page is titled "Sign in to djibb" with a "Sign me in" button;
  it has only `signin` and `sudo` modes: `magic.ts:887-903`. [code]
- The consent page then reads "Welcome! This connects **<label>** to your
  djibb identity. Requested by <origin>" with one Connect button:
  `connect.ts:449-499`. [code]

ADR 0024 §2 says a white-label user "never sees the word djibb until the
interstitial" (`docs/adr/0024-...md:93-96`). The email contradicts that.

Workarounds without core work: lead with Google sign-in, which completes in
one browser, and have `/accounts/verified` detect a missing verifier and tell
the user to open the link on the device where they started.

### B4. CORS does not allow two headers `@djibb/client` sends (soft)

- Allowed request headers are `Authorization`, `Content-Type`,
  `x-replicache-requestid`: `packages/server-cf/src/index.ts:114-118`. [code]
- Hono's CORS middleware echoes exactly the configured list when it is
  non-empty (`node_modules/hono/dist/middleware/cors/index.js`, hono 4.12.25).
  [code]
- Production confirms it. A preflight to `https://api.djibb.com/entities`
  from `Origin: https://djibb.com` asking for `x-djibb-active-account`
  returned `access-control-allow-headers:
  Authorization,Content-Type,x-replicache-requestid`. [prod]
- `createTransport` sends `X-Djibb-Active-Account` when `activeAccount` is
  passed: `packages/client/src/transport.js:179`. [code]
- `pushMutation` always sends `X-Djibb-Push-Outcomes`:
  `packages/client/src/oneshot.js:161`. [code]

Effect [inferred from the Fetch preflight rules]: a browser on any origin
other than the API's own will refuse those requests. For the new client this
means do not pass `activeAccount` (a Bearer principal has one account, so the
header is redundant: `packages/server-cf/src/catalog/fetch.ts:28-32`,
`packages/server-cf/src/auth/resolver.ts:116-150`), and do not use
`@djibb/client/oneshot` from the browser.

Side effect worth its own look: djibb.com passes `activeAccount` on
`GET /entities`, the audit log, the connected-clients surface, and three
account calls (`apps/djibb-com/src/lib/entities.js:16`,
`apps/djibb-com/src/lib/api/audit.js:63`,
`apps/djibb-com/src/lib/api/connected.js:63`, `:91`,
`apps/djibb-com/src/lib/api/account.js:13`, `:69`, `:103`). Those should be
failing in production browsers today. I did not open a browser to confirm.

## The Bearer surface, route by route

All [code]. "Works" means the handler accepts a `credential` principal and
the CORS and CSRF layers pass a browser request whose origin is in
`AUTHORIZED_DOMAINS`.

| Need | Route or mutator | Bearer, off-domain | Evidence |
|---|---|---|---|
| Who am I, email, verified flag | `GET /auth/session` | Works | `packages/server-cf/src/auth/fetch.ts:247-257` |
| Create an entity | `initList` via `POST /list/push` | Works; creator becomes `owner`, `default_role` is `restricted` | `list/fetch.ts:454-497`; `auth/resolver.ts:164-190`; `packages/protocol/src/list/mutators/initList.ts:97-113` |
| Set `defaultRole` or `slot` at creation | `initList` args | Operator only | `initList.ts:42-48` |
| Push and pull | `POST /list/push`, `/list/pull` | Works | `packages/client/src/replicache.js:220-279`; `list/fetch.ts:400-572` |
| My owned entities | `GET /entities` | Works; owner role only, lists and templates only | `catalog/fetch.ts:23-37`; `packages/server-cf/src/derived-index/d1.ts:678-696` |
| Shared with me | `GET /a/<suffix>/shared` | Works | `packages/server-cf/src/account/fetch.ts:73-87` |
| Pending invitations | `GET /a/<suffix>/invitations` | Works; needs a verified email on the account | `account/fetch.ts:96-119` |
| My workspaces | `GET /a/<suffix>/workspaces` | Works | `account/fetch.ts:25-39` |
| Send an invitation | `inviteByIdentity` | Works; owner or admin; see B1 | `inviteByIdentity.ts:55` |
| Accept an invitation | `acceptInvitation` | Works below the read floor; identity must match a verified email | `packages/protocol/src/list/mutators/acceptInvitation.ts:65-66`, `:162-178`; `durable_object.ts:908-945` |
| Change rules or a member's role | `setListAuthRules`, `changeMemberRole`, `removeMember` | Works; owner or admin | `packages/protocol/src/list/mutators/setListAuthRules.ts:50`; `changeMemberRole.ts:51` |
| Transfer ownership | `transferOwnership` | Refused for any Bearer caller | `durable_object.ts:1433-1446` |
| Delete account, detach session account, sudo | `/auth/account/delete`, `/auth/session/accounts`, `/auth/sudo/request` | Session cookie only | `auth/fetch.ts:104`, `:165`; `magic.ts:561` |
| Resolve member names | `GET /<type>/connected` | Owner or admin only | `list/fetch.ts:326-356` |

Session-cookie-only routes are all account-management actions that belong on
djibb.com. Nothing the Secret Santa client needs for wishlists, groups, or
invitations requires the cookie.

One gap the table exposes: a non-manager member has no protocol route from an
account id to a display name. `/connected` is the only resolver and it is
manager-gated. The client can store names as list content instead, so this is
a design input for the group-entity ticket and not a blocker.

## CORS and `AUTHORIZED_DOMAINS`

All [code] unless tagged.

- An allowlisted origin gets its own origin echoed with credentials allowed;
  any other origin gets `*` without credentials: `index.ts:104-121`.
- Every non-GET request needs an `Origin` whose host is in the allowlist, or
  it gets a bare 403: `index.ts:124-174`. Three routes are exempt:
  `/auth/magic/consume`, `/auth/connect/token`, `/auth/connect/consent`.
- Push and pull are POSTs, so the client origin must be allowlisted for sync
  to work at all. GET routes would answer a non-allowlisted origin, because a
  Bearer request uses `credentials: 'omit'` and `*` suffices.
- The CSRF check matches by host and ignores scheme
  (`packages/server-cf/src/utils/origin.ts:51-68`). The connect ceremony
  matches the exact origin string (`connect.ts:105-114`). An entry that
  satisfies the first can fail the second. Write full origins with no
  trailing slash.
- The first entry is the canonical frontend for magic-link sign-in redirects
  (`magic.ts:260-263`) and all email links (`notifications.ts:96-97`). The
  new client's origin must be appended after `https://djibb.com`, never
  placed first.
- No `Access-Control-Max-Age` is configured (`index.ts:113-121`). Browsers
  then cache a preflight for a few seconds at most, so most pushes and pulls
  cost two requests, per entity URL. [inferred] This already applies to
  djibb.com.

## Opening many entities at once

- One Replicache instance per `(account, entity)`; the store name is
  `<accountId>:<entityId>`: `packages/client/src/replicache.js:105-107`.
  [code] IndexedDB is per origin, so the client's stores cannot collide with
  djibb.com's stores for the same account and entity. [inferred from the
  platform]
- Nothing in `@djibb/client` or the worker caps the instance count. ADR 0027
  relies on this (`docs/adr/0027-read-secrecy-via-entity-decomposition.md`,
  Decision 3). [code]
- No licence key is passed or needed: `replicache.js:63-64`. The installed
  package's `license` field still points at the Rocicorp terms
  (`node_modules/replicache/package.json`), so the "went open source" comment
  rests on upstream's announcement, which I did not re-verify. [code for the
  field]
- Each instance polls every 60 seconds and pulls on every poke. About 21
  entities per user means about 21 pulls per minute per open tab, each with a
  preflight, a worker invocation, a D1 credential check, an entity read, and
  a DO call (`auth/principal.ts:125-128`; `list/fetch.ts:186-217`). At ten
  users this is small. It grows linearly with entities per user, which is an
  argument for fewer, larger companion entities. [inferred]
- Rate limits: pushes use the 600-per-minute account bucket. Websockets use
  the anonymous bucket (B2). Pulls are unthrottled.
- Browser limits on concurrent websockets are in the hundreds per browser as
  I recall them. Not verified here.
- All entities share one mutator registry
  (`packages/client/src/replicache.js:13`, `:65`), so companion entities are
  ordinary lists with list mutators. An anonymity-by-construction ledger with
  its own `markTaken` mutator (ADR 0027 Decision 5) would be a protocol
  change.

## The connect ceremony, as a user meets it

Server side, all [code]:

1. **Start.** Google: a top-level navigation to
   `GET /auth/google?connect=1&code_challenge=…&label=…`. The origin is taken
   from the `Referer` header and must be allowlisted, or the worker returns
   500: `packages/server-cf/src/auth/oauth.ts:130-148`, `:166-186`.
   Magic-link: `POST /auth/magic/request` with
   `connect: { origin, code_challenge, label }`; a bad origin is a 400:
   `magic.ts:120-126`, `:367-369`.
2. **Prove identity.** Google's own screens, or the emailed link, which lands
   on the worker's click-through page.
3. **Disclosure.** The worker's consent page, unskippable, one Connect
   button, valid for 15 minutes: `connect.ts:82`, `:449-499`, `:545-576`.
4. **Return.** Redirect to `<origin>/accounts/verified?code=…`; the code
   lasts 5 minutes and is single-use: `connect.ts:64`, `:636-638`.
5. **Exchange.** `POST /auth/connect/token` returns `access_token`,
   `token_type`, `account_id`, `credential_id`. The token lasts 90 days and
   cannot be refreshed: `connect.ts:72`, `:255-315`. The exchange is limited
   to 20 per minute per IP: `connect.ts:263`; `wrangler.toml:49-52`.

First visit with Google [inferred]: tap sign in, pick a Google account,
approve Google's consent for an app named for djibb, see "Welcome, Name! This
connects Secret Santa to your djibb identity", tap Connect, land back in the
app. One browser throughout.

First visit with email [inferred]: type an address, receive "Sign in to
djibb" from "djibb sign-in", open it, tap "Sign me in" on a djibb page, tap
Connect on a second djibb page, land back in the app. Three taps on two
djibb-branded pages after an email that does not mention the app, and only if
the email is opened in the same browser (B3).

Second device: the whole ceremony again. It mints a second, independent
credential row. Nothing links or limits them.

Expiry and sign-out:

- An expired or revoked token resolves to anonymous
  (`auth/principal.ts:125-142`). On an entity whose `default_role` is
  `restricted`, the next pull returns 200 and deletes every cached content
  key, because the role dropped below the read floor:
  `durable_object.ts:562-564`, `:619-630`. The app shows empty lists and gets
  no error. Pushes fail with 403 and stay queued:
  `durable_object.ts:1427-1431`, `:1536-1554`;
  `packages/server-cf/src/auth/errors.ts:21-25`. `GET /auth/session` and
  `GET /entities` return 401. [code]
- No route revokes an unbound credential. The only writers of `time_revoked`
  are account deletion (`packages/server-cf/src/auth/d1.ts:319-350`) and the
  manager revoke for entity-bound tokens (`auth/d1.ts:1035-1050`;
  `list/fetch.ts:369-398`). Connect-ceremony tokens are unbound, so "sign
  out" can only forget the token locally; the credential stays valid for the
  rest of its 90 days. [code]

## Extraction chores

**E1. Connect-ceremony client.** No code outside the server tests generates a
verifier, starts a ceremony, or calls `/auth/connect/token`. A repo-wide
search for `code_challenge`, `code_verifier`, and `connect/token` in
`packages/client`, `apps`, `e2e`, and the CLI finds nothing. The Secret Santa
client is the first to drive it, which the doc acknowledges at
`docs/creating-a-client.md:125-126`. Write it in `@djibb/client`: PKCE pair,
start for both methods, exchange, token storage, and a missing-verifier
state.

**E2. Websocket helper.** The opener is
`apps/djibb-com/src/lib/websocket.js:17-28` and duplicates `entityPath`
(`packages/client/src/replicache.js:118-122`). The doc undercounts the work:
the message loop that turns a poke into `pull()` and routes
`mutation_outcome` is copied inline in five route files, for example
`apps/djibb-com/src/routes/l/[id]/+page.svelte:163-177`. `partysocket` is a
djibb-com dependency, not a `@djibb/client` one
(`apps/djibb-com/package.json:45`).

**E3. Multi-entity manager.** djibb-com's `initList` shell is Svelte and opens
one entity (`apps/djibb-com/src/lib/replicache/index.svelte.js:38-216`). A
client holding about 21 instances needs open, close, and socket lifecycle for
a set of entities, plus the on-screen-only socket policy from B2. New code,
best placed in `@djibb/client` so it is framework-free.

**E4. Dev runner.** `npmrundev.mjs:22-23` hard-codes the worker and
`apps/djibb-com`. A second app needs its own script or a parameter.

**E5. End-to-end journey.** `e2e/` has no script that runs the connect
ceremony. Step 6 of the doc asks each client to add one for its auth path.
The magic-link dev seam returns the landing URL when `ENV=dev` and
`_dev: true` (`magic.ts:192-199`, `:442-449`), which makes this scriptable.

## Doc fixes for `docs/creating-a-client.md`

**D1.** Lines 258-265 say item-level read secrecy does not exist and needs a
new ADR. ADR 0027 settled it, and the view floor it depends on is enforced in
`durable_object.ts:430-436`, `:562-636`. Line 274 says the Secret Santa
client "is itself blocked on gap #1"; that is stale for the same reason.

**D2.** Lines 157-160 and 246-249 say a missing `AUTHORIZED_DOMAINS` entry
500s every request. Today a missing or empty value makes non-GET requests 403
and leaves GETs working (`utils/origin.ts:34-42`, `:51-68`;
`index.ts:163-172`). Only OAuth start still 500s (`oauth.ts:137-148`).
`packages/server-cf/.dev.vars.example:1-4` carries the same stale sentence.

**D3.** Say that the new origin goes after `https://djibb.com`, as a full
origin with no trailing slash. See the CORS section.

**D4.** Lines 150-153 say to treat a 401 or 403 as "reconnect". Add that a
pull never returns either: an expired token yields a 200 that empties the
local cache. The client should check `GET /auth/session` on load and on
focus.

**D5.** Add that the token response carries no expiry, so the client must
record its own 90-day clock, and that there is no sign-out or self-revoke
route.

**D6.** Lines 109-112 and 146-149 tell every Bearer client to pass
`{ origin }`. In a browser `Origin` is a forbidden header and the value is
ignored; the browser's real origin is what the allowlist sees. The parameter
matters only to non-browser clients (`packages/client/src/transport.js:61-66`).

**D7.** Lines 212-215 describe `GET /entities` as needing
`credentials: 'include'` and the active-account header. With a Bearer token
it needs neither, and the header must not be sent (B4). Add the three sibling
reads the step omits: `/a/<suffix>/shared`, `/a/<suffix>/invitations`,
`/a/<suffix>/workspaces`.

**D8.** Lines 54-56 say `pushMutation` is in
`packages/server-cf/bin/djibb.ts`. It is imported there from
`@djibb/client/oneshot` (`packages/server-cf/bin/djibb.ts:42-44`). Lines
182-191 present the one-shot helpers without saying they fail CORS in a
browser (B4).

**D9.** Lines 65-67 say to decide the licence per client. The gate requires
every `apps/*` workspace to be `PolyForm-Shield-1.0.0`
(`scripts/check-licenses.mjs:19-22`).

**D10.** Lines 198-204 call the schema version an inline value; it is the
exported `SCHEMA_VERSION` (`packages/client/src/replicache.js:85`), though
still in `@djibb/client` and not `@djibb/protocol`. Separately, the comment
"no polling" at `replicache.js:69` is wrong: the 60-second default applies.

**D11.** Add to Step 2 or Step 5 that a Bearer caller cannot run terminal
mutators, so a client cannot hand an entity to another owner. This bears on
ADR 0027's rule that the giftee must not own the companion entity: the right
person has to create it.

**D12.** The ceremony contract (lines 128-153) should add: keep the verifier
in storage that survives a same-tab redirect; start Google with a top-level
navigation that sends a `Referer`, since `Referrer-Policy: no-referrer`
breaks it (`oauth.ts:130-148`); handle a missing verifier on return (B3).
For local dev, note that `localhost` ports are same-site, so a developer
signed in to djibb-com sends the session cookie on websocket handshakes from
the second app, and that a valid cookie always outranks a Bearer token
(`auth/principal.ts:107-123`). [inferred for the browser behaviour]

**D13.** Step 4 should say `GET /entities` returns every list and template
the account owns, from every client, as `id`, `type`, `name` only
(`derived-index/d1.ts:654-696`). The Secret Santa client's entities will
appear in djibb.com's picker, and the reverse. The client needs its own way
to recognise its entities.

Claims in the doc that I checked and found correct: the workspaces glob
(`package.json:14-17`); the `SameSite=Lax` cookie (`auth/constants.ts:22`);
`randomString(43)` as a PKCE-legal verifier
(`packages/protocol/src/id/index.ts:7-8`, `:27`); S256-only PKCE
(`connect.ts:136-143`); the 90-day token (`connect.ts:72`); the credential
threading through `createReplicacheClient` (`replicache.js:49-81`);
`wrapMutators` (`replicache.js:155-195`); the websocket `?c=` tag
(`durable_object.ts:1747-1759`).

## Local dev for a second app

1. `npm install` at the root.
2. `cp packages/server-cf/.dev.vars.example packages/server-cf/.dev.vars`,
   then append the second app's exact origin after the existing entries, for
   example `http://localhost:5173;https://djibb.com;http://localhost:5174`.
3. `wrangler d1 migrations apply djibb-auth --local` from
   `packages/server-cf`.
4. Pin the second app's dev port. The ceremony matches the origin exactly, so
   a port that drifts when 5173 is taken breaks sign-in.
5. Give the app its own API-origin env var pointing at
   `http://localhost:8787`; `@djibb/client` never reads env
   (`packages/client/src/origins.js:26-57`).
6. Start the worker and the app separately, or extend `npmrundev.mjs` (E4).
7. Sign in locally by magic link with `_dev: true`, which returns the landing
   URL; local email is simulated (`wrangler.toml:61-69`). Google needs OAuth
   credentials in `.dev.vars`
   (`packages/server-cf/.dev.vars.example:19-20`).

Local behaviour that differs from production: IP-keyed limits share one
`unknown-ip` bucket (`utils/rateLimit.ts:44-46`), and the same-site cookie
note in D12.

## Not verified

- Nothing was run. Every "works" above is a reading of the handlers, and no
  browser has driven the ceremony from a real off-domain origin, here or in
  the repo's tests.
- That djibb.com's `activeAccount` calls fail in production browsers (B4).
- Replicache behaviour with 20 or more instances in one tab.
- Cloudflare billing and browser websocket limits at this scale.
