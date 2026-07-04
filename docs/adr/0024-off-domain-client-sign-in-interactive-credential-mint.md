# ADR 0024: Off-domain client sign-in — the interactive credential mint

- **Status:** Accepted; not yet implemented. Amends ADR 0010 (the interactive ceremony gains a
  second terminal form: a minted credential, not only a same-site session) and
  ADR 0022 (fills the "device-flow mint UX" hole it named out of scope; the
  `issued_credentials` substrate is unchanged). Does not touch authorization
  (ADR 0021).
- **Date:** 2026-07-04
- **Layer:** protocol, server-cf

## Context

The project's posture is that clients live **on their own domains**, scattered
across the internet — ideally, people use the djibb protocol without ever
knowing djibb.com exists. djibb.com is one client among many, not the center.

That posture breaks the current interactive auth story. ADR 0010's ceremonies
(OAuth, magic-link) terminate by minting a **session ridden as the
`djibb-session` cookie** — `SameSite=Lax`, host-only on the API origin. That
works only for clients same-site with the API (`*.djibb.com`). An off-domain
client gets nothing usable out of the ceremony: the cookie exists, but the
browser won't send it cross-site.

ADR 0022 built the other half already: `issued_credentials` gives any client a
nameable, revocable, single-Account bearer token, verified at the one
request→Account seam. But it deliberately left the *mint UX* out of scope —
today tokens are operator-minted (seed-operator). That was fine while every
client was first-party plumbing; it cannot serve a world where a user finds a
weird client in the wild and signs in themselves.

The missing piece is therefore exactly one thing: **an interactive ceremony
whose output is a credential instead of a cookie.** Notably, the worker
already implements the front half — the interactive flows store an allowlisted
`referer_origin` and redirect back to `<origin>/accounts/verified` on success
(`auth/oauth.ts`, `auth/magic.ts`). What's missing is the back half: handing
the returning client something it can actually authenticate with.

There is also a product hazard this ADR treats as a design input, not an
afterthought. Cross-client identity continuity — type the same email into a
second weird client months later and *your stuff is already there* — is the
protocol's magic moment. It is also, executed carelessly, indistinguishable
from creepy tracking. The difference is decided here, structurally.

## Terminology

Grounded in CONTEXT.md and ADR 0022; this ADR adds two terms.

- **Connect ceremony** — an interactive authentication (ADR 0010 method) run
  on the auth worker that terminates by minting an `issued_credentials` row
  for a specific client and returning the token to that client. The
  non-cookie sibling of the session-minting ceremony.
- **Connection moment** — the instant within the ceremony where an existing
  Account is (or a new Account is about to be) attached to a new client. The
  one place cross-client identity is allowed to reveal itself.

## Decision

### 1. The connect ceremony: authorization-code + PKCE over the existing flows

An off-domain client obtains its credential through a redirect ceremony on
the auth worker:

1. The client sends the user to the worker with its **origin**, a
   **PKCE code challenge**, and a **client label**; the worker validates the
   origin against its allowlist and stores it (the existing `referer_origin`
   mechanism, hardened per §5).
2. The user completes any ADR 0010 interactive method — magic-link or OAuth.
   Method availability is unchanged; passkey slots in later exactly as ADR
   0010 planned.
3. On success the worker redirects back to the client's origin with a
   **single-use, short-TTL authorization code** — instead of (not in addition
   to) setting the session cookie for that flow.
4. The client exchanges code + PKCE verifier at a worker **token endpoint**,
   which mints an `issued_credentials` row — `account_id` from the ceremony,
   `label` from the client, `time_expires` per policy — and returns the raw
   token once.

The output is an ordinary ADR 0022 credential: verified at the one
request→Account seam, acting at the Account's resolved role per entity
(ADR 0021), visible and revocable in the management surface. **No new table,
no new authorization model, no new credential type.** The ceremony is a new
way for an existing row to come into being.

The same-site cookie ceremony is unchanged and remains the right path for
clients in the djibb.com family. It becomes the special case, not the norm.

### 2. Branded and white-label are the same machinery

Whether the user experiences this as a hosted **"Sign in with djibb"** page or
as **white-label** — the client renders its own "enter your email" box, drives
`/auth/magic/request` itself, and the user never sees the word djibb until the
interstitial — is a **client product decision, not a protocol one**. Both run
the identical ceremony: worker-side verification, code redirect, token
exchange. ADR 0010's discipline holds throughout: the emailed link lands on
the worker's interstitial; a client frontend never holds a raw magic-link
token.

The protocol prescribes only what §1 says. The branding question is settled
per client — with one exception the substrate imposes, in §3.

### 3. The connection moment: magic, not tracking — by construction

Cross-client continuity must feel like recognition, never like surveillance.
The difference is not tone of copy; it is **who reveals the connection, when,
and what the client is allowed to learn**. Three structural rules:

1. **The shared identity speaks only on surfaces it owns.** Recognition
   ("welcome back — this connects *Secret Santa* to your djibb identity")
   happens on the worker's ceremony pages (interstitial / hosted page) and on
   the management surface — never inside a client. A white-label client may
   hide djibb from its sign-in *form*, but it cannot skip the worker
   interstitial, and the interstitial always discloses the connection being
   made before completing it. The user can decline there, before any
   credential exists. This is the one branding floor §2's client freedom does
   not reach.
2. **A client learns only the ceremony's output.** The token exchange returns
   the credential and its `account_id` — nothing else. No enumeration of the
   Account's other clients, credentials, or entities; what the Account can
   *see* through the client is governed entirely by ADR 0021 roles, exactly
   as if the user had walked in any other door. Continuity is something the
   *user* experiences ("my lists are here"), not data the *client* receives.
3. **Every connection is legible and severable.** Each connect ceremony
   yields a labeled `issued_credentials` row in the ADR 0022 §6 union view:
   what connected, when, last used, Revoke. The antidote to creepy is not
   hiding the linkage — it is announcing it at the moment it forms, with the
   revoke handle already in the user's hand.

Creepy is discovering a connection after the fact; magic is being told at the
connection moment, by the identity layer itself, on its own surface. The
substrate enforces the disclosure; clients cannot opt out of it.

### 4. Public clients only — PKCE mandatory, no client secrets

Scattered clients (static pages, browser apps, other people's weird
deployments) cannot keep secrets. The ceremony therefore assumes **public
clients**: PKCE is mandatory on every exchange, codes are single-use with a
short TTL, and there are no client secrets to issue, store, or leak. A
client's identity for ceremony purposes is its **allowlisted origin + its
label**; its accountability lives in the credential row that results.

### 5. Registration is staged; v1 is first-party allowlist

- **v1:** ceremony origins are validated against the existing
  `AUTHORIZED_DOMAINS` allowlist — operator-registered, first-party. The
  redirect target must be exactly the allowlisted origin (no path or
  subdomain wildcards beyond what the allowlist states).
- **Opening to unregistered third-party clients is explicitly gated** on two
  deferred decisions this ADR names but does not make:
  - **(a) Per-credential role narrowing.** ADR 0022 deferred `role_ceiling`
    because first-party clients holding full-role tokens are fine. A
    stranger's client holding a token that acts at the user's full resolved
    role on everything they own is a materially bigger grant;
    `bound_entity_id` covers single-entity clients, and a ceiling (or
    entity-decomposition guidance with teeth) is the likely prerequisite for
    roaming ones. Deferring stays cheap on one condition: the carrier that
    threads `bound_entity_id` forward from the request→Account seam into
    per-entity authz (ADR 0022's named negative consequence) must be built
    as a **plural-ready credential-constraints annotation**, not a
    single-purpose binding path — a later ceiling rides the same carrier or
    the retrofit stops being the "clean later addition" ADR 0022 promised.
  - **(b) A registration stance.** Either a self-serve client-registration
    surface, or a deliberate "open ecosystem: any origin, PKCE public
    clients, disclosure interstitial always shown" decision. The env-var
    allowlist is an operator bottleneck by design and does not scale to
    strangers; replacing it is its own ADR.

### 6. Browser token handling stays client-owned, with a substrate assist

Per ADR 0022 §1, how a client stores its credential is the client's business.
The substrate assists rather than polices: `time_expires` is **recommended
non-NULL for browser-held tokens** (bounded blast radius on XSS theft),
`bound_entity_id` is available for single-entity clients, and re-running the
connect ceremony is cheap by design — a client that holds tokens only in
memory and reconnects per visit is a legitimate posture, not a failure mode.

## Consequences

**Positive:**

- Any client on any domain can authenticate a user with zero backend changes
  beyond an allowlist entry — the "weird clients cheap" boundary now extends
  off-domain.
- The seed-operator mint bottleneck dissolves: this ceremony *is* the
  self-serve mint UX ADR 0022 deferred. A device-code variant of the same
  ceremony later covers the CLI's mint.
- The magic moment is load-bearing and protected: continuity reveals itself
  only at the connection moment, on the substrate's own surface, revocable.
- Staying OAuth-*shaped* (code + PKCE + token endpoint) means a future move
  to standards-track OAuth/OIDC is a rename, not a rework.

**Negative / load-bearing:**

- The worker's ceremony pages (interstitial, hosted sign-in) become a
  user-facing product surface with real design stakes — §3's disclosure
  lives or dies on that copy and flow.
- `@djibb/client`'s pusher/puller are cookie-only (`credentials: 'include'`);
  the transport must be auth-parameterized to carry `Authorization: Bearer`
  before any off-domain Replicache client works. (The CLI's hand-rolled
  push/pull was the first consumer; this is the second — extraction is due
  per ADR 0014's rule.)
- Bearer tokens in browsers are XSS-stealable; §6's expiry recommendation
  mitigates but does not eliminate. Accepted for v1 with first-party clients.
- The code redirect suppresses the session cookie for that flow (§1.3); the
  ceremony code paths must keep the two terminal forms cleanly separate or a
  client could end up with both.

**Neutral:**

- Sessions, the cookie path, and djibb.com's sign-in are unchanged.
- Authorization is untouched: ADR 0021's `(Account, entity) → role` is the
  sole permission model; a connect-ceremony credential is not special.

## Considered and rejected

- **Widen the cookie (`SameSite=None`) instead.** Rejected: buys only
  browser clients, reopens CSRF across every allowlisted origin, and still
  leaves non-browser clients on operator-minted tokens. The credential path
  serves all client shapes with machinery that already exists.
- **Adopt a full standards-track OAuth 2.1 / OIDC authorization server.**
  Rejected for now: we own both ends of every v1 flow, and the standard's
  surface (discovery, dynamic registration, id-tokens, scopes) is weight
  without a consumer. Staying OAuth-shaped preserves the upgrade path; §5(b)
  is where standardization would re-enter.
- **Silent recognition** (client signs the user in; continuity just appears).
  Rejected as the creepy branch of §3: the linkage would be discovered rather
  than announced. The disclosure interstitial is mandatory even white-label.
- **Client secrets / confidential clients.** Rejected: scattered clients
  can't keep them, and a secret implies a registration ceremony §5 defers.
  PKCE is the public-client answer.
- **Returning the raw token in the redirect** (implicit-style). Rejected:
  tokens in URLs leak (history, referrer, logs). The code + exchange hop is
  cheap and standard.
- **A new `client_registrations` table now.** Rejected as building ahead of
  the second consumer; the allowlist suffices until §5(b) is actually
  decided.

## Out of scope

- **`role_ceiling` / per-credential narrowing** — named as a gate in §5(a);
  its design remains deferred exactly as ADR 0022 left it.
- **Third-party registration or the open-ecosystem decision** — §5(b); its
  own ADR when the first stranger appears.
- **Refresh tokens.** v1 tokens live until `time_expires` or revocation;
  re-running the ceremony is the refresh. A refresh grant is a clean later
  addition if ceremony fatigue proves real.
- **The CLI device-code variant** — same ceremony, different front end;
  a build item under ADR 0022's sequencing, not new decisions.
- **Passkeys in the ceremony** — arrive via ADR 0010's ladder untouched.
- **What the management surface renders** — ADR 0022 §6 already covers it;
  connect-ceremony credentials are ordinary rows there.

## Sequencing

1. Token endpoint + authorization-code tail on the existing ceremony
   (reusing the `referer_origin` front half), PKCE enforced; behind the
   existing allowlist.
2. Disclosure interstitial: the §3 connection-moment surface, designed as
   product, not as an error page.
3. Auth-parameterize the `@djibb/client` transport (Bearer alongside
   cookie); fold the CLI's hand-rolled push/pull into it (ADR 0014 second
   consumer).
4. First consumer: the Secret Santa client end-to-end on its own domain —
   proving ceremony, storage posture, and revocation before any third party
   exists.
5. Only then: revisit §5's gates if/when a third-party client is real.
