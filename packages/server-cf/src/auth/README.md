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

## Files

| file | responsibility |
| --- | --- |
| `principal.ts` | the `RequestPrincipal` union — the auth seam's output type |
| `resolver.ts` | principal resolution + `(principal, entity) → role` ladder |
| `middleware.ts` | Hono adapter: runs the seam, sets `principal` on the context |
| `d1.ts` | session / credential / account row access (the D1 substrate) |
| `account-row.ts` | the `accounts` row shape + mappers |
| `oauth.ts`, `google.ts` | Google OAuth ceremony + in-house OIDC client |
| `magic.ts` | magic-link ceremony (ADR 0010) |
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
