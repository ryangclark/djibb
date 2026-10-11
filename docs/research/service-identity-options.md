# Service identity for the Secret Santa client: what it must do, where it could run

Research for GH #79 (map: #76). Planning only; no product code changed.
Date: 2026-10-11. Code citations are against `main` at `46b78d844`.

Each claim is marked **[code]** (read in this repo), **[docs]** (Cloudflare
documentation, fetched 2026-10-11), or **[inferred]** (reasoned from the
former two, not run). Nothing here was executed against a worker.

## Short answer

A service identity is feasible today with no protocol change. It is an
ordinary account holding a Bearer token; over `/push` it can create entities
it owns, add and remove members directly by account id, invite by email, and
archive. The two things it cannot do with a Bearer token are
`transferOwnership` and deleting its own account. What is missing is
operational rather than architectural: there is no self-serve way to get a
*non-expiring* token for a non-operator account, djibb emits no events to a
backend (the service must be called or must poll), and ADR 0027's
identity-free `markTaken` mutator does not exist.

## 1. How an issued-credentials account is minted today

- **Accounts** are created in exactly two places: OAuth sign-in and magic-link
  consume (`packages/server-cf/src/auth/oauth.ts:47`, `:295`;
  `packages/server-cf/src/auth/magic.ts:280`), both through `CreateAccount`
  (`packages/server-cf/src/account/service.ts:18-58`), which also mints a
  personal workspace. The only other path is raw SQL: `seed-operator` inserts
  the `accounts` row itself (`packages/server-cf/bin/seed-operator.ts:100-104`).
  **[code]**
- **Credentials** are minted by `CreateCredential`
  (`packages/server-cf/src/auth/d1.ts:836-871`). Its only runtime caller is the
  connect-ceremony token exchange (`packages/server-cf/src/auth/connect.ts:295-300`),
  which always stamps a 90-day expiry (`connect.ts:72`, `:299`). The only other
  mint is `seed-operator`'s raw `INSERT INTO issued_credentials`
  (`seed-operator.ts:118-122`), which writes no `time_expires` (non-expiring)
  and is hard-coded to `a/djibb` (`seed-operator.ts:52`). **[code]**
- Tokens are non-refreshable; re-running the ceremony is the refresh
  (`docs/adr/0024-off-domain-client-sign-in-interactive-credential-mint.md:251-253`,
  `docs/creating-a-client.md:150-153`). **[code]**

**Can a non-operator service account exist without manual DB work?** Yes, with
a catch. **[inferred from the above]**

| Path | Manual DB work | Token lifetime | Human step |
|---|---|---|---|
| Sign up via magic link to a mailbox you control, then run the connect ceremony from an allowlisted origin | None | 90 days, then a human must redo the ceremony in a browser (interstitial consent included) | Every 90 days |
| Adapt `seed-operator` to a second account id (it is ~10 lines of SQL) | One `wrangler d1 execute` | Non-expiring, revoke-only | Once |
| Reuse the operator account `a/djibb` and its existing token | None | Non-expiring | None |

Reusing the operator is possible but couples a client backend to the one
principal that passes `isOperator` (`packages/server-cf/src/list/durable_object.ts:1489`;
privileged `slot`/`defaultRole` in `packages/protocol/src/list/mutators/initList.ts:128-132`).
A leaked client secret would then be a leaked platform-operator token.

A 90-day token covers one season (Halloween to Christmas is under 90 days) but
not year-round wishlists.

## 2. What a Bearer token can and cannot do

All entity writes go through `POST /{list|template|workspace}/push`
(`packages/server-cf/src/list/fetch.ts:442`). Bearer resolution is uniform:
`Authorization: Bearer` is read at `packages/server-cf/src/auth/middleware.ts:46-52`
and resolved to a `credential` principal at
`packages/server-cf/src/auth/principal.ts:125-139`; role resolution does not
distinguish it from a session (`packages/server-cf/src/auth/resolver.ts:95-151`).
Non-GET requests must carry an `Origin` header that is in `AUTHORIZED_DOMAINS`
(`packages/server-cf/src/index.ts:163-172`). The CLI is the working reference:
`cliTransport` (`packages/server-cf/bin/djibb.ts:458-465`) and the `initList`
pushes in `promote` (`djibb.ts:888-902`).

| Operation | Mutator / route | Gate | Bearer? | Citation |
|---|---|---|---|---|
| Create an entity it owns | `initList` | Pre-init: principal must hold the claimed `accountId`; creator becomes `owner`, `default_role: 'restricted'` | Yes | `fetch.ts:454-497`; `resolver.ts:164-190`; `initList.ts:97-112` |
| Set `default_role` at creation | `initList.defaultRole` | Operator only. Not needed: an authed creator already gets `restricted` | n/a | `initList.ts:104`, `:128-132` |
| Replace `authorization_rules` wholesale | `setListAuthRules` | owner or admin; only check is at-most-one owner | Yes | `packages/protocol/src/list/mutators/setListAuthRules.ts:50-79` |
| Add a member by account id, no invite | `changeMemberRole` (upserts; "acts as a direct add") | owner or admin | Yes | `packages/protocol/src/list/mutators/changeMemberRole.ts:20-26`, `:51`, `:96-100` |
| Remove a member | `removeMember` | owner or admin | Yes | `packages/protocol/src/list/mutators/removeMember.ts:49-92` |
| Invite by email | `inviteByIdentity` | owner or admin; preflight caps of 10 per hour and 25 outstanding **per inviter account, across all entities** | Yes, but the caps bind a shared service account quickly | `packages/protocol/src/list/mutators/inviteByIdentity.ts:55`; `packages/server-cf/src/list/invitations.ts:302`, `:310`, `:404-425` |
| Accept an invitation | `acceptInvitation` | Any role; preflight requires the acting account's verified email to match | Yes (it is a push) | `packages/protocol/src/list/mutators/acceptInvitation.ts:65-66`; `invitations.ts:536-579` |
| Transfer ownership | `transferOwnership` | **Refused for any Bearer credential** (`terminal_mutator_requires_interactive_client`); target must already be a member | **No** | `durable_object.ts:1434-1469`; `packages/protocol/src/list/mutators/_shared.ts:263-273`; `transferOwnership.ts:128-130` |
| Hand ownership by role change | `changeMemberRole` with `role: 'owner'`, sent by the current owner; old owner is demoted to `admin` | owner | Yes; not in `TERMINAL_MUTATORS` | `changeMemberRole.ts:77-89`; `_shared.ts:263-273` |
| Soft-delete an entity | `archiveList` | Any edit role (owner, admin, editor, checker). Hard delete follows 30 days later | Yes | `packages/protocol/src/list/mutators/archiveList.ts:22`; `durable_object.ts:2229` |
| Read content | `POST /pull` | view floor: `restricted`/`submitter` get an empty patch | Yes | `fetch.ts:400-421`; `resolver.ts:203-221` |
| Read the mutation log | `GET /audit` | owner or admin | Yes | `fetch.ts:259-263` |
| "Who am I" for a token | `GET /auth/session` | any authed principal; returns the account | Yes | `packages/server-cf/src/auth/fetch.ts:247-256` |
| Delete own account | `POST /auth/account/delete` | **Session only**, plus sudo step-up | **No** | `auth/fetch.ts:100-104`, `:121-132` |
| Sudo step-up, session detach | `/auth/sudo/request`, `DELETE /auth/session/accounts` | Session only | No | `packages/server-cf/src/auth/magic.ts:560`; `auth/fetch.ts:164` |

A token can also be bound to one entity (`bound_entity_id`, enforced at
`fetch.ts:173-184`), but a service that owns many entities needs an unbound one.

Three side findings from this table:

1. **The terminal guard and `changeMemberRole` disagree.** A Bearer caller is
   refused `transferOwnership` but can achieve the same swap with
   `changeMemberRole(role: 'owner')`. Human users of an off-domain client are
   Bearer-only, so this second path is the *only* way they could hand an
   entity to anyone. It looks like an oversight, so a design should not depend
   on it staying open. **[code]** for both halves; the judgment is mine.
2. **An `admin` can replace the owner via `setListAuthRules`.** It is gated on
   owner-or-admin and checks only that the new rules have at most one owner
   (`setListAuthRules.ts:50`, `:59`), while `changeMemberRole` explicitly
   forbids admins minting owners (`changeMemberRole.ts:65-71`). Consequence for
   this client: grant nobody `admin` on a hidden entity. **[code]**
3. **Givers can archive the Claims entity.** ADR 0027 puts givers at
   `editor`/`checker` on Claims
   (`docs/adr/0027-read-secrecy-via-entity-decomposition.md:130`), and
   `archiveList` admits both. A mis-tap by one giver trashes the group's claims
   until someone unarchives. **[code]**

## 3. Human creates then hands over, or service creates?

- **Service creates** is the clean path: one `initList` push with the service's
  `accountId` and `workspaceId: null` yields an entity owned by the service
  with `default_role: 'restricted'` and nobody else on it (`initList.ts:97-112`).
  `workspaceId` should stay `null`: workspace membership passes straight
  through as a role on the entity (`resolver.ts:61-74`), so filing a hidden
  entity under any human's workspace would admit that workspace's members.
  **[code]**
- **Human creates then hands over** works only through
  `changeMemberRole(role: 'owner')` (side finding 1), leaves the human as
  `admin` until the service removes them, and means the excluded person (or an
  organizer) minted and knows the id of the hidden entity. For Claims on a
  giftee's own wishlist it is the wrong direction: ADR 0027 §4 says the
  excluded principal must never administer the hidden entity
  (`0027...md:91-96`). **[code + inferred]**

## 4. What the service would have to do for this client

None of this exists; it is the job description implied by ADR 0027 plus #76.
**[inferred]** throughout, built on the verified operations in §2.

**Own the hidden entities.** Per wishlist (or per wishlist-and-group, a model
decision for another ticket), `initList` a Claims entity; the giftee is never
added. If a cross-group ledger is used, `initList` that too.

**Keep giver membership in step with group membership.** `changeMemberRole` to
add and `removeMember` to drop, by account id. Two prerequisites:

- The service needs each giver's **account id**. Nothing looks an account up by
  email for a caller. The practical sources are the group entity's own
  `authorization_rules` (the service must be a member of the group entity to
  pull it) or the client passing its user's token so the service can call
  `GET /auth/session`.
- The service needs a **trigger**. djibb sends nothing outbound to a backend:
  the only change signal is the per-entity websocket poke
  (`docs/creating-a-client.md:175-177`). So either the client calls the service
  when membership changes, or the service polls `/pull` on a schedule.

Inviting by email from the service account is a poor fit: the 10-per-hour and
25-outstanding caps are per inviter (`invitations.ts:302`, `:310`), and one
service account would be the inviter for every family. People should join the
*group* by a human organizer's invite and be added to hidden entities directly.
Note the same caps apply to that organizer: inviting a dozen relatives in one
sitting hits the hourly cap. That belongs to the "Joining" item on #76.

**Cross-group taken-ness.** ADR 0027 §5 describes a ledger whose only write
mutator is an identity-free `markTaken` (`0027...md:110-118`). That mutator is
not in the registry (`packages/protocol/src/list/mutators/index.ts:90` onward;
no `markTaken` anywhere in `packages/`), and there is no per-entity restriction
on which mutators an edit role may call. Three ways through:

- (i) The service is the ledger's only writer and givers are `viewer` on it.
  The service copies "taken" (without identity) from each group's Claims into
  the ledger. Anonymous by construction, no new mutator, but needs the trigger
  above and adds lag to double-buy prevention.
- (ii) One Claims entity per wishlist shared by every giver in every group. No
  ledger and no copy step, but givers in one family see which member of the
  other family claimed an item.
- (iii) Add `markTaken` to the protocol. That is core code and an ADR, contrary
  to ADR 0027's "zero new core code" (`0027...md:197`).

**Run a draw no human can read in full.** The service computes the assignment
in memory and writes one small entity per giver: owned by the service, that
giver as `viewer`, `default_role: 'restricted'`, nobody else. Each giver's pull
returns only their own; the organizer is on none of them. The mutation log is
readable only by owner or admin (`fetch.ts:259-263`), which is the service. Two
honest limits: whoever holds the service token or D1/DO access (the operator)
can read everything, so "no human" means "no participant"; and manual
assignment mode has an organizer who knows by definition.

## 5. Hosting options

### (a) A separate Cloudflare Worker owned by the client app

- Calls `api.djibb.com` exactly as the CLI does: Bearer token plus an
  allowlisted `Origin`. Zero change to `packages/server-cf` beyond the
  `AUTHORIZED_DOMAINS` entry the client needs anyway
  (`docs/creating-a-client.md:157-160`, `:242-245`). **[code]**
- **Secret.** A Worker secret is an encrypted binding whose value is "not
  visible within Wrangler or Cloudflare dashboard after you define" it;
  `wrangler secret put` creates and deploys a new version; local dev reads
  `.dev.vars` or `.env`. **[docs: workers/configuration/secrets]**
- **Reaching the API.** `api.djibb.com` is attached as a Custom Domain
  (`docs/DEPLOY.md:27-31`). Cloudflare documents that same-zone fetches from
  one Worker to another Worker on a Custom Domain work without a binding,
  whereas a Worker on a Route is reachable only via a service binding.
  **[docs: workers/configuration/routing/custom-domains]** A service binding is
  also available: no public URL, "zero overhead or added latency", no added
  cost, target must be on the same account, counts toward subrequest limits,
  32 Worker invocations per request. **[docs: workers/runtime-apis/bindings/service-bindings]**
  A binding still enters `djibb-server`'s `fetch` handler, so the Origin check
  and Bearer auth apply unchanged. **[inferred]**
- **Scheduling.** Cron Triggers call a `scheduled()` handler; finest schedule
  is every minute; changes take up to 15 minutes to propagate.
  **[docs: workers/configuration/cron-triggers]** Limits: 5 cron triggers per
  account on Free, 250 on Paid; CPU 10 ms on Free, 30 s on Paid for
  sub-hourly schedules and 15 min for hourly or longer; subrequests 50 per
  request on Free, 10,000 on Paid. **[docs: workers/platform/limits]**
  `djibb-server` already uses one cron (`packages/server-cf/wrangler.toml`
  `[triggers]`). A per-minute poll over many entities would not fit the Free
  CPU or subrequest limits. **[inferred]**
- **Costs and risks.** A second deployable with its own secret, tests and
  deploy step. The secret is a single key to every hidden entity for every
  family. The service's own HTTP surface needs its own caller authentication
  (verify the caller's token via `GET /auth/session`). Token expiry (§1). All
  the service's writes share one `RL_ACCT_WRITE` bucket of 600 per minute
  (`wrangler.toml`; `fetch.ts:153-159`), which is ample for two families.
  Not verified: that the Workers runtime lets `fetch` set an `Origin` header
  the way Node does for the CLI.
- Matches ADR 0021 Decision 3 and ADR 0027 §4 as written: the weird client
  brings its own backend (`0027...md:101-106`).

### (b) A module or route inside `packages/server-cf`

- Gains: one deploy, the existing cron, direct DO stub access, and it could
  skip HTTP and tokens entirely by calling `handlePush` on the stub the way the
  purge driver does (`packages/server-cf/src/auth/purge.ts:66-93`). **[code]**
- Costs: it puts one client's business rules inside the shared protocol
  backend, which the client guide says not to do ("never a client-specific
  mutator gate", `docs/creating-a-client.md:232-236`; "a new client usually
  ships without touching the backend", `:243-245`). Stub-level access makes the
  `system` role reachable to that code (`_shared.ts:77-93`), which is far more
  authority than an owner. Every future client would have a precedent for
  adding its own module. If it still acts as an account, it needs the same
  account and the same purge discipline as (a). **[code + inferred]**

### (c) No service: a human organizer owns hidden entities ("party-grade")

- Needs nothing new; ADR 0027 §4 describes it (`0027...md:97-100`).
- The human owner and their client do everything in §4. What that rules out or
  weakens for the v1 scope on #76:
  - **One wishlist feeding several groups with shared taken-ness.** ADR 0027
    says the shared ledger has no shared human organizer and "must be owned by
    a service identity" (`0027...md:211-216`). Without a service the fallback is
    one human owning Claims across both families, and that human cannot be a
    giftee on it, so Claims about *their own* wishlist needs a second owner.
  - **A draw nobody can peek at.** The organizer's browser would compute the
    draw and the organizer would own every assignment entity, so the organizer
    can read all of it. The organizer is normally also a participant.
  - **Membership sync** happens only while the organizer's client is open, and
    secrecy rests on that client never adding the giftee.
  - **Anonymous ledger** is unavailable without option (iii) in §4.
  - Free-for-all and assigned mode *within one group*, with purchase marking
    hidden from the giftee, still work.
- The purge hazard gets worse, not better: the owner is now a real person who
  can delete their account (§6).

## 6. The account-purge and orphan hazard

- An account is purged only after it is tombstoned, and the only tombstone path
  is `POST /auth/account/delete`, which requires a **session** (not a Bearer
  token) and a sudo step-up completed in the last 5 minutes via an emailed link
  (`auth/fetch.ts:100-132`, `:45`; `magic.ts:560`). There is no inactivity
  purge: the daily sweep selects only tombstoned accounts past a 7-day grace
  window (`packages/server-cf/src/scheduled.ts:22-37`; `d1.ts:406`, `:471-485`).
  **[code]**
- Tombstoning immediately revokes every credential for the account
  (`d1.ts:319-352`), so the service stops working at once, a week before any
  entity changes hands. Restore within grace is by emailed link
  (`auth/fetch.ts:93`). **[code]**
- At purge, each entity the account owns goes to the most senior remaining
  member in the order admin, editor, checker; only if none exists is it set to
  `default_role: 'ownerless'` (`_shared.ts:419-423`, `:468-503`;
  `packages/protocol/src/list/mutators/relinquishOwnershipOnPurge.ts:67-93`).
  This refines ADR 0027's statement of the hazard (`0027...md:204-210`):
  - **Claims** (givers are editor/checker): ownership passes to one giver.
    Still private, but that giver can now add the giftee.
  - **Viewer-only entities** (the per-giver draw results, a service-written
    ledger): no eligible successor, so they become `ownerless`, which is
    readable and editable by anyone with the id (`resolver.ts:203-211`;
    `_shared.ts:19-25`). **[code]**
- **What keeps a service account alive [inferred]:** nobody ever holds a
  session for it. An account whose email is not a deliverable mailbox (as
  `seed-operator` does with `operator@djibb.internal`, `seed-operator.ts:103`)
  cannot be signed into, cannot complete sudo, and so cannot be tombstoned
  through any HTTP route. An account created by magic link to a real mailbox
  can be deleted by whoever controls that mailbox. The remaining risks are
  direct D1 edits and token loss or expiry, which stop the service without
  orphaning anything.

## Things that could block or slow the build

No hard blocker to a service identity was found. Items needing a decision or a
small chore before building:

1. **Non-expiring service token** needs a D1 insert (adapted `seed-operator`)
   or acceptance of a 90-day manual re-connect.
2. **Identity-free `markTaken` does not exist.** Cross-group anonymity needs
   the service as sole ledger writer, or a new protocol mutator, or acceptance
   that claimer identity is visible across groups.
3. **No server-to-backend events.** The service must be called by the client
   or poll.
4. **Do not rely on `transferOwnership`** from any Bearer client, including
   human users of the off-domain app.
5. Adjacent, for the "Joining" item: invite caps of 10 per hour and 25
   outstanding per inviter (`invitations.ts:302`, `:310`), and invite emails
   link to the first `AUTHORIZED_DOMAINS` origin, i.e. djibb.com, not the
   client (`packages/server-cf/src/list/notifications.ts:90-101`).

## Sources

Repo files cited inline. Cloudflare documentation:

- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

Note on location: the repo had no existing convention for research notes, so
this file starts `docs/research/`.
