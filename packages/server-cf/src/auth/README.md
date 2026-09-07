# Auth

This directory is the worker's authentication layer: how a request becomes an
identity, and how that identity becomes a *role* on the entity it's touching.
The ADRs are the source of truth for the *why*; this README is a map of the
*what* and where it lives.

> **History note.** An earlier version of this file described an
> email/password login and a Clerk-style `org:resource:action` permission
> string. Neither shipped. The app authenticates with Google OAuth and
> magic-link, and authorization is `(Account, entity) → role` (ADR 0021), not
> capability strings. If you're looking for the old brainstorm, it's in git.

## The two halves

**Authentication** answers *who is this request?* — and its output is a single
discriminated union, the `RequestPrincipal` (`principal.ts`):

```
anonymous                         — no credential presented
session   { accounts, sessionId } — the interactive djibb-session cookie
credential{ account, credentialId } — an issued_credentials Bearer token
```

Every request funnels through one seam, `resolvePrincipal` (`resolver.ts` +
`middleware.ts`), which reads either the cookie or the `Authorization: Bearer`
header and produces exactly one of the three. There is no fourth path and no
synthesized fake session (ADR 0022 §2).

**Authorization** answers *what may this identity do here?* — `resolver.ts`
maps `(principal, entity)` to an `AuthorizationRole` via the per-account
specificity ladder (explicit per-entity grant → workspace membership →
`default_role`), with the `X-Djibb-Active-Account` header as the cross-account
tiebreak (ADR 0021). Authentication says who you are; authorization decides
what that identity may do. The two never collapse into each other.

## How an identity is minted

Three ceremonies, all landing in the same `accounts` / `sessions` /
`issued_credentials` substrate:

- **Google OAuth** (`oauth.ts`, `google.ts`) — `GET /auth/google` starts it,
  `GET /auth/google/verify` finishes it. `google.ts` is our in-house Google
  OIDC client (replaced the deprecated `arctic` dep, #52); the
  `GoogleIdentity` Effect service (`../effect/oauth.ts`) is the seam.
- **Magic-link** (`magic.ts`, ADR 0010) — `POST /auth/magic/request` mints and
  emails a single-use token; `GET /auth/magic/land` renders the click-through
  interstitial; `POST /auth/magic/consume` validates it and signs in. This is
  the identity *floor*: any email can reach an Account without a password.
- **Connect ceremony** (`connect.ts`, ADR 0024) — the off-domain path. An
  interactive ceremony whose terminal form is a **Bearer credential** instead
  of the same-site cookie, so a client on its own domain can authenticate a
  user. `POST /auth/connect/token` exchanges a single-use authorization code +
  PKCE verifier for an `issued_credentials` row (#28). `GET`/`POST
  /auth/connect/consent` is the §3 disclosure interstitial shown before any
  code is minted (#29): it discloses the connecting client and, on affirmative
  **Connect**, mints the code. (v1 is affirmative-only — no decline button;
  see ADR 0024's §3 amendment.)

Account resolution across all three is email-first, then provider `sub`, then
create (ADR 0010 option C): the same email reaches the same Account regardless
of method.

## How an identity is deleted

The connect ceremony's affirmative-only consent (ADR 0024 §3) leans on identity
deletion as a real exit path, so it's built as a **user-facing verb**
(`magic.ts` / `fetch.ts`, GH #58) — Phase 1 of a two-phase design:

- **`POST /auth/account/delete`** — **session-only** (a bearer credential must
  never delete the identity it's scoped to) and gated behind a fresh **sudo**
  step-up for *that same account*. On success it soft-deletes the account
  (`accounts.time_deleted`) and, in one atomic batch, revokes every issued
  credential, removes the account from every session (reaping sessions left
  empty; a multi-account session keeps its other accounts), and drops the
  identity's pending magic-link / connect-code / connect-pending rows. "Delete"
  is felt instantly — signed out everywhere, every connected client dead.
- **Sudo mode** (`POST /auth/sudo/request` → a `purpose='sudo'` magic-link →
  consumed via `/auth/magic/consume`) — a GitHub-style re-auth. Consuming the
  link stamps the *current* session sudo-fresh (`sessions.time_sudo` +
  `sudo_account_id`, 5-minute window). It mints no session and creates no
  account; it must land in the browser holding the session, so it's same-device.
- **Deferred to Phase 2 (a follow-up vs GH #15):** the scheduled hard purge of
  PII and the owned-shared-entity handling (`transferOwnership`). The
  `time_deleted` tombstone is what buys the grace window to do that safely.

Two guards make "deleted" actually deny even before the purge: `GetSessionById`
drops a tombstoned account from any session it loads, and
`VerifyBearerCredential` fails closed on a token whose account is tombstoned.
The djibb-native uniqueness index also excludes tombstoned rows, so a deleted
identity's email is free to sign up again.

## Files

| file | responsibility |
| --- | --- |
| `principal.ts` | the `RequestPrincipal` union — the auth seam's output type |
| `resolver.ts` | principal resolution + `(principal, entity) → role` ladder |
| `middleware.ts` | Hono adapter: runs the seam, sets `principal` on the context |
| `d1.ts` | session / credential / account row access (the D1 substrate) |
| `account-row.ts` | the `accounts` row shape + mappers |
| `oauth.ts`, `google.ts` | Google OAuth ceremony + in-house OIDC client |
| `magic.ts` | magic-link ceremony (ADR 0010) + sudo-mode step-up (#58) |
| `connect.ts` | off-domain connect ceremony: token endpoint + §3 interstitial (ADR 0024) |
| `constants.ts` | cookie names/attributes, OAuth redirect URIs |
| `errors.ts` | auth error types |
| `fetch.ts` | the `/auth/*` route table |

## Related ADRs

- **0010** — magic-link floor + interactive ceremony account resolution.
- **0021** — the read model and `(Account, entity) → role` authorization.
- **0022** — client authentication: the `issued_credentials` Bearer token and
  the one request→Account seam.
- **0024** — off-domain client sign-in: the interactive credential mint.
