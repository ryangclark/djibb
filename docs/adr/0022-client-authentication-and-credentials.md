# ADR 0022: Client authentication and credentials

- **Status:** Accepted; not yet implemented. Amends ADR 0010 (adds an
  `issued_credentials` sibling table to the auth substrate, and names the
  interactive/non-interactive auth-method split). Supersedes the copied-session
  CLI authentication path (`DJIBB_OPERATOR_SESSION` replayed as the
  `djibb-session` cookie) in `packages/server-cf/bin/djibb.ts`.
- **Date:** 2026-06-22
- **Layer:** protocol, client/cli

## Context

djibb is a **core protocol** shared between server and clients. A *client* is
anything that speaks that protocol: djibb.com (CONTEXT.md already names it "the
djibb.com client"), the `djibb` CLI, an email-reply integration where a user
answers an authenticated email and an LLM turns the body into mutations, and —
later — standing bots/agents. Clients may be weird one-offs; the protocol does
not require them to play nicely with each other, only to follow it.

That raises two questions this ADR answers, and one boundary it draws:

1. **How does a client authenticate?** djibb.com mints a session on
   OAuth/magic-link (ADR 0010) and rides it as the `djibb-session` cookie. The
   CLI authenticates by **copying a real human session token** into the macOS
   keychain (`DJIBB_OPERATOR_SESSION`) and replaying that same cookie. That works
   but is impersonation: the token is indistinguishable from the operator at a
   browser, carries full session power, cannot be revoked without killing the
   human's web session, and — fatally for the management surface we want —
   **cannot be named** as a distinct thing. You cannot manage what you cannot
   name.

2. **As whom does a client act?** When a user replies "add milk" to an authed
   email, the actor is *that user's Account* — the inbox is their identity proof,
   exactly as a djibb.com session is. But a standing bot operated by no single
   person is its own actor; attributing its actions to a human would be false.
   These two must not be modeled the same way — but the distinguisher is **not**
   "was a human in the loop?" (you can pilot a browser or a CLI just as easily as
   an inbox; liveness is undetectable from a request).

3. **What is protocol vs. client-owned?** The protocol prescribes only
   *authenticate-to-an-Account* and *authorization* (ADR 0021 roles on entities).
   Everything about how a client mints, stores, and presents its credential is
   client-owned weirdness. This boundary is what keeps "weird clients" cheap.

## Terminology

Grounded in CONTEXT.md; this ADR adds only *credential*.

- **Client** — anything that speaks the djibb protocol (djibb.com, CLI,
  email-reply integration, bot). The one noun for "a way in." (No "channel.")
- **Account** — a verified-identity with a stable `a/` ID (CONTEXT.md §Account).
  The durable actor; the contract boundary for authorization.
- **Principal** — who a request resolves to for role-resolution: an Account, or
  the anonymous public (CONTEXT.md §Authorization roles). An Account *is* a
  principal; we say "Account" except where the anonymous case is in play.
- **Credential** — a **non-interactive auth method**: a pre-issued secret a
  client presents to authenticate as an Account without a live sign-in ceremony.
  Sibling to the *interactive* methods (OAuth, magic-link, passkey) of ADR 0010.

## Decision

### 1. Authentication is protocol; how a client authenticates is its own affair

The protocol prescribes exactly two things about access: a request
**authenticates to an Account** (or is anonymous), and that Account **resolves to
a role per entity** (ADR 0021). A client is free to be weird above that line:
how it obtains, stores, and presents its credential is client-owned. The "see
all my clients/credentials" settings surface is therefore a **feature of the
djibb.com client** rendering protocol-level data — not part of the protocol.
(djibb.com being a client that views shared state is not a paradox; it is the
"djibb uses itself" principle.)

### 2. One resolve seam; authorization unchanged

Every client funnels into one **request→Account** seam — which is
`auth/session.ts` / `auth/middleware.ts` (where a request is identified today),
**not** `auth/resolver.ts`. The latter is `resolveRole(session, rules,
workspace_role) → role` — pure, per-entity *role* resolution — and it stays
untouched. Credential verification extends the request→Account seam to admit a
bearer token alongside the session cookie. Clients differ only in how a
credential arrives and is verified — cookie, `Authorization: Bearer`, a reply-to
token. They **never** differ in what the resulting Account may do; that stays ADR
0021's single model, `(Account, entity) → role`. No client grows its own
permissions.

### 3. A client either operates an existing Account or has its own

This is an **identity-assignment decision made when a client is set up**, not a
per-request detection of who is "really" driving:

| Client | Acts as | Why |
|---|---|---|
| Browser (djibb.com) | the signed-in Account | the human's own session |
| `djibb` CLI | the operator's Account | a tool the operator runs; their identity |
| Email-reply integration | the inbox-owner's Account | the inbox *is* that human's identity proof |
| Standing bot / scheduled agent / shared automation | **its own Account** | no single human behind it; its own verified identity (e.g. djibb-native per ADR 0010) |

- A client that is a **tool a person uses** operates that person's Account. The
  tool is plumbing, like a browser; attribution lands on the human, honestly.
- A client that is **its own actor** gets its own Account, shared-with and
  role-assigned through the existing roster (ADR 0021), revoked with the existing
  *Remove access* verb. A bot is a member row — no new authorization mechanism.

The choice is recorded as the `account_id` on the client's credential. It is not
inferred at request time.

### 4. `issued_credentials` — the non-interactive auth-method substrate

A credential lets a client authenticate as an Account without an interactive
sign-in ceremony. It **does not replace sessions** — djibb.com's session is
multi-account (`sessions` + the `AccountSession` join, `auth/session.ts`) and
stays in its own substrate. `issued_credentials` is the *non-interactive
sibling*: where the interactive methods mint a (multi-account) session, this
table holds pre-issued, single-Account, bearer tokens. It follows the
sibling-table pattern of the auth substrate — today only `magic_link_tokens`
(migration 0005) is built; ADR 0010 additionally *designs* `account_credentials`
(passkeys, deferred). So every row here is a token; there is no `kind` column and
sessions are not modeled here (see §6 for how the management surface unions both).

```sql
CREATE TABLE issued_credentials (
    credential_id    TEXT NOT NULL PRIMARY KEY,  -- public handle, safe to display
    secret_hash      TEXT NOT NULL,              -- SHA-256(raw); raw lives only in the issued token
    account_id       TEXT NOT NULL,              -- the single Account this token acts as
    label            TEXT,                       -- human-set: "Ryan's laptop CLI", "Secret-Santa bot"
    bound_entity_id  TEXT,                       -- NULL = usable wherever the Account has access; else this entity only
    time_created     INTEGER NOT NULL,
    time_last_used   INTEGER,                    -- best-effort/throttled; not written on every request (hot path)
    time_expires     INTEGER,                    -- NULL = non-expiring (revoke-only)
    time_revoked     INTEGER                     -- NULL until revoked; soft state, never hard-deleted
);

CREATE INDEX idx_creds__by_account ON issued_credentials(account_id);
```

- **The client lives in `label`, never in a type column** — a new client is a new
  label, not a new schema concept. (The earlier `cli_token`/`session` `kind`
  enum is gone: it over-fit clients, and the session form doesn't live here.)
- **Hash discipline mirrors magic-link (ADR 0010):** the raw secret exists only
  in the issued token; a DB read alone cannot mint a live credential. Unsalted
  `SHA-256` is acceptable **only because tokens are high-entropy random** (no
  dictionary/rainbow surface); this entropy requirement is load-bearing — a
  low-entropy token format would need a slow KDF instead.
- **`time_last_used` is best-effort.** A write on every authenticated request is
  a hot-path cost for a nicety; throttle it (coarse granularity, async) rather
  than writing synchronously per request.
- **`bound_entity_id` scopes a `token` to one entity** (email-reply tokens are
  issued per entity; a leaked token can't roam). It leverages the id-prefix
  convention, so the same column binds to a List, Template, Workspace, *or*
  Account (`l/`, `w/`, `a/`, …) — one mechanism across every entity kind. `NULL`
  for general clients (usable wherever the Account has access).
- **A credential acts at its Account's full resolved role; per-credential
  narrowing is deferred** (see Out of scope). A `token` operating an existing
  Account does whatever that Account can on the bound entity — an email-reply
  `token` on an Account that is `owner` acts as `owner`. v1 has no role clamp.
- **Revoked/expired rows are retained** (`time_revoked`/`time_expires` as soft
  state; hard-deleted only on account/cascade delete) so a client can render
  credential history.

### 5. Credentials are attributable

A mutation carries the acting `credential_id` through the push envelope to the
outcome record, so a mutation-log view can render *what* acted ("via Ryan's
laptop CLI", "via email-reply"), not merely which Account.

### 6. The access surface is the grant-axes union, rendered by a client

"What can touch this entity" is the union of the independent grant axes ADR 0009
named (entity-direct grant, workspace-implicit membership, `default_role` floor,
pending invites) plus **credentials**. Under §3 this is mostly free: bots with
their own Account are already member rows; credentials operating a human's
Account surface as their own rows (label, `bound_entity_id`, last-used, Revoke).
Because sessions live in their own substrate (§4), a complete "what's connected"
view **unions two sources** — active sessions (`sessions`/`AccountSession`) and
issued tokens (`issued_credentials`) — exactly as the access surface already
unions multiple grant axes.

> **Amended in implementation (GH #23):** this view is a **union read**, *not* an
> ADR 0003 D1 projection. The projection pipeline (DO-authoritative → D1 emit +
> ADR 0007 reconciliation) exists to copy state that *originates in a Durable
> Object*. Neither source here does: `sessions` and `issued_credentials` are
> natively authoritative in D1, so there is nothing to emit or reconcile — the
> surface simply reads and unions the two tables (`auth/connected.ts`
> `ListConnectedClients`). ADR 0003 is not contradicted (it governs DO-owned
> *entity* data); the auth substrate is just out of its scope. The original
> "credentials projection emitted to D1 via the ADR 0003 pipeline" wording below
> is superseded by this note.

Presenting it
adjacent to the existing roster — and a credential-history view, and mutation-log
attribution — are **djibb.com-client features** captured as follow-up issues that
reference this ADR; they do not change the protocol-level substrate decided here.

## Consequences

**Positive:**

- One resolve seam; authorization stays single-model regardless of client.
- The CLI becomes a named, revocable, attributable client instead of an
  operator-session impersonation.
- A new client = a new `label` (and maybe a `bound_entity_id`), not a new
  authorization model and not a new credential type.
- The protocol/client boundary keeps "weird clients" cheap: the protocol verifies
  a credential and resolves an Account; the rest is the client's business.

**Negative / load-bearing:**

- The acting-`credential_id` must thread through the push envelope to the outcome
  record, or mutation-log attribution can't be served.
- The credentials D1 projection is derived state with ADR 0007 reconciliation
  responsibilities.
- `bound_entity_id` **cannot be enforced at the request→Account seam** — the
  target entity is route-dependent and not yet in scope there. The token's
  binding must thread *forward* from credential-verification into the per-entity
  authz check (where the entity is known), which rejects a bound token on any
  entity but its own. Name the carrier (e.g. an annotation on the resolved
  request context) explicitly; "enforce in `resolve()`" is the one place it can't
  live. Must be tested directly.
- ADR 0010's "Account-ID at contract boundaries" discipline extends: credentials
  key on `account_id`, never email.

**Neutral:**

- The djibb.com `session` is **unchanged** — it remains multi-account in its own
  substrate (`sessions`/`AccountSession`). This table is the non-interactive
  sibling, not a session replacement; the management surface unions both (§6).
- Whether a given integration operates an existing Account or its own is a setup
  choice; the protocol records the result, it does not police the reason.

## Considered and rejected

- **Keep the CLI on a copied human session.** Rejected: not nameable, not
  independently revocable, full-power — the blocker to any management surface.
- **Per-client authorization** ("webapp can do more than the API"). Rejected:
  clients are ways in; permission is ADR 0021's single model. Letting a client
  decide what you can do is the fragmentation this ADR prevents.
- **"Human in the loop at request time" as the identity discriminator.**
  Rejected: undetectable — a browser or CLI can be piloted as readily as an inbox.
  The real axis is the setup-time choice of *operate an existing Account vs. own
  Account* (§3).
- **Client-named credential kinds** (`cli_token`, `email_reply`, `agent`).
  Rejected as over-fitting today's clients; `kind` is the credential *form*
  (`session`/`token`), the client lives in `label`.
- **A per-credential role clamp (`role_ceiling`) at v1.** Considered for making
  an email-reply `token` append-only even when its Account is `owner`. Dropped
  for v1: a credential acts at its Account's role, and the narrowing need is met
  when it arises by entity-decomposition (operate a separate Account that holds
  only `submitter` on the entity — ADR 0021's mechanism) rather than a new clamp
  axis. A `role_ceiling` column remains a clean later addition if decomposition
  proves too heavy.

## Out of scope

- **The device-flow mint UX** (how the CLI obtains a `token`) — a build detail.
- **Per-credential role narrowing.** A credential acts at its Account's full
  resolved role in v1. When a client must do *less* than its Account can (e.g. an
  email-reply path that should be append-only), the v1 answer is
  entity-decomposition — operate a separate Account holding only the lesser role
  (ADR 0021) — not a clamp on the credential. A `role_ceiling` column is a clean
  later addition if that proves too heavy.
- **New interactive auth methods** (additional OAuth providers, "Sign in with
  djibb" for sibling apps) — ADR 0010 territory; this ADR only leaves the
  interactive/non-interactive split named so they slot in cleanly.
- **Agent runtime** — ADR 0018 (sidecar); here an agent is just a client with its
  own Account and a `token`.
- **Share Links** — bearer, no-recipient-identity invites (ADR 0009 §Out of
  scope); a credential authenticates *an Account*, a Share Link does not.
- **Step-up / sensitive-action confirmation** — ADR 0023.

## Sequencing

1. `issued_credentials` migration + extend the request→Account seam
   (`auth/session.ts` / `middleware.ts`) to verify a bearer token and resolve its
   Account, carrying any `bound_entity_id` forward to the per-entity authz check
   (not enforced at this step — see Negative consequences). `resolveRole` is
   untouched.
2. CLI device-flow mint + switch `djibb promote` off `DJIBB_OPERATOR_SESSION`
   onto a real `token`. Proves the model end-to-end.
3. Acting-`credential_id` threaded through the push envelope to the outcome
   record (unblocks mutation-log attribution).
4. The credentials D1 projection (ADR 0003 emit) + the djibb.com access-surface
   rows.
5. Entity-bound `token`s for the email-reply client (depends on that client's
   build).
