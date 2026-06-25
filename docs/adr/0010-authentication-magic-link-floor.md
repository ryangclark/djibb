# ADR 0010: Authentication — magic-link floor, OAuth, opt-in passkey

- **Status:** Accepted; magic-link floor and OAuth implemented (`workers/src/auth/magic.ts`, `workers/src/auth/oauth.ts`); passkey 2FA remains the opt-in/forthcoming tier per §Decision
- **Date:** 2026-05-17
- **Layer:** protocol, server-cf

## Context

djibb today authenticates exclusively via Google OAuth. The Account row
in D1 stores a verified email derived from the provider's `email_verified`
claim, and sessions are minted on successful OAuth callback. This is
sufficient for the current user base — all of whom necessarily have a
Google account — but is constraining for three reasons that have now
landed on the critical path:

1. **ADR 0009 (Invitations) is gated by email coverage.** Email
   invitations to addresses on non-Google providers
   (`bob@protonmail.com`, `bob@self-hosted.io`, anything corporate not
   on Google Workspace) currently dead-end at the sign-in wall — the
   invitee has no sign-in path. Email invitations cannot ship usefully
   until djibb supports authentication for arbitrary emails.

2. **No coherent multi-method story.** As authentication methods
   proliferate (OAuth providers, passkey, magic-link), the Account
   model must answer "are these the same person?" deterministically.
   Today's "Account-per-OAuth-provider" implicit model breaks the
   moment two methods land for one human.

3. **No clear position on password.** Password authentication is the
   default expectation many users bring to web apps. Adopting it
   imposes real operational cost (hashing, breach response, reset
   flows, lockouts). Declining it requires being able to defend the
   decision. The conversation needs to be settled now, before the auth
   surface fragments.

The decisions below resolve all three.

## Decision

### The auth ladder

```
Floor:     Email control     —    magic-link  OR  OAuth (`email_verified`)
Step 1:    Provider-mediated —    OAuth inherits the provider's posture
Step 2:    Floor + passkey   —    opt-in 2FA, phishing-resistant primary
```

**Email control is the floor.** Any authentication system whose
recovery path is "click this link in your email" has email-controls-account
as its effective security ceiling, regardless of what gates the
*interactive* path. Password + email recovery and magic-link occupy the
same floor — the password is theatrical security above an already-fixed
ceiling. We accept the floor honestly and skip the theater.

### Three methods supported, one excluded

| Method | Status | Role |
|---|---|---|
| **Magic-link** | v1 | Auth floor. Passwordless one-time email-bound tokens. The path that makes email invitations (ADR 0009) actually deliverable for non-OAuth-provider addresses. |
| **OAuth** | Existing (Google) | Elevation onto provider-mediated trust. Routes to the same Account when the verified email matches a known Account. |
| **Passkey** | Future (opt-in 2FA) | A credential users add to their Account *after* signing in via magic-link/OAuth. Phishing-resistant primary path; magic-link/OAuth remain fallbacks. Platform-UX maturity is the gating concern. |
| **Password** | **Excluded permanently** | Adds operational surface (hashing, breach response, lockouts, reset flow that is itself a magic-link) without raising the security ceiling. Architecture deliberately does *not* anticipate it. |

### Email is the matching key; Account-ID is the contract boundary

The Account row has a stable internal ID (`a/<suffix>`) — that is its
identity. The verified email is *how the world finds the Account at
sign-in and invitation time*, not *what the Account is*. This split is
deliberate:

- **At matching surfaces** (sign-in lookup, invitation `(target_id,
  identity_value)`, OAuth-callback email-to-Account resolution), email
  is the key. Bob types or clicks an email; djibb finds the Account.
- **At contract boundaries** (entity DO `authorized_accounts`,
  "shared with me" indexes, `pending_invites` post-accept,
  cross-DO references), Account ID is the key. Email never appears.

This discipline-rule is what allows:

- Email-change flow (later) to swap one column without touching
  authorization.
- Multi-email-per-Account (later, via `account_emails(account_id, email,
  is_primary)`) to add a table without touching authorization.
- Multi-method routing (multiple OAuth providers, magic-link, passkey)
  to converge on the same Account purely by email-match — no
  ambiguity about *which* Account a session ends up on.

### Identity-canonicalization: chosen path

Three coherent shapes were on the table:

- **(A) Hard email-canonical bijection.** `UNIQUE(email)` on Account;
  one Account per email is a permanent constraint. Email-change is
  account-rebuild. Multi-email humans use multi-Account session.
- **(B) Account-ID-canonical, many emails.** `account_emails` sibling
  table from day one. Email-change is natural. Multi-email humans get
  one Account with many addresses.
- **(C, chosen) Email-canonical for matching at v1; Account-ID-canonical
  at every contract boundary.** Ship the simple schema (one email
  column with `UNIQUE`), but architect entity-side code so it refers
  only to Account IDs. The schema can later evolve toward (B) as a
  localized auth-substrate change without touching entity DOs.

(C) is the choice. It ships the simplicity of (A) without inheriting
(A)'s downstream commitments. (B) is the natural evolution target if
multi-email pain materializes.

### Magic-link mechanism

Substrate is D1, sibling to OAuth state:

```sql
CREATE TABLE magic_link_tokens (
    token_hash TEXT NOT NULL PRIMARY KEY,   -- SHA-256(raw token); raw token lives only in the emailed URL
    target_email TEXT NOT NULL,             -- lowercased
    purpose TEXT NOT NULL,                  -- 'signin' (later: 'verify_email_change', etc.)
    time_created INTEGER NOT NULL,
    time_expires INTEGER NOT NULL,
    time_consumed INTEGER,                  -- NULL until consumed; single-use
    request_ip TEXT,
    user_agent TEXT
);

CREATE INDEX idx_magic__by_email_time
    ON magic_link_tokens(target_email, time_created);
```

Routes (sibling to `workers/src/auth/oauth.ts`):

- `POST /auth/magic/request { email }` — mint token, store hash, send
  email via `workers/src/email`. Returns 200 unconditionally — never
  leaks whether the email is known.
- `GET /auth/magic/land?token=<raw>` — interstitial "Click to sign in"
  page. Solves the corporate-email-prefetch problem (mail scanners
  that prefetch links would otherwise consume the token before the
  user clicks).
- `POST /auth/magic/consume { token }` — hash, look up, validate
  (single-use, not expired), resolve-or-create Account by
  `target_email`, mark consumed, create session, redirect to
  sanitized `?next=`.

**Policy defaults:**

- **Expiry:** 15 minutes from creation. Lazy-expire on read.
- **Single-use:** consume marks `time_consumed`; second consume fails.
- **Rate limits:** per-target-email 3 / 15 min and 10 / 24h; per-IP 20
  / hour.
- **Resend cooldown:** 60 seconds from the sign-in page.
- **Token storage:** SHA-256 of raw token in D1. Raw token never
  persisted server-side. A DB read alone cannot mint live sessions.

### Account resolution: same email, same Account

Sign-in by any method routes to the Account whose `email` matches the
session's verified identity:

- **OAuth signin:** provider returns `(sub, email, email_verified)`.
  If `email_verified` is trusted (Google: yes; others: case-by-case),
  look up Account by `email`. If found, sign in. If not, create.
- **Magic-link consume:** the clicked-token proves email control.
  Look up Account by `target_email`. If found, sign in. If not, create.
- **Passkey assertion** (future): WebAuthn verifies the credential.
  The credential is already linked to an Account ID. Sign in directly;
  no email roundtrip.

The Account row records `email` (the canonical identity), but **does
not** record "auth provider" as a column. Provider information is
stored only as:

- `oauth_linkages(provider, sub, account_id)` for OAuth providers
  (so a Google `sub` can be remembered for stable identity even if the
  Google user later changes their primary email — see "Email change"
  below).
- `account_credentials(credential_id, account_id, public_key, ...)`
  for passkeys.
- Nothing recorded for magic-link — the email itself is the proof.

A single Account can therefore accumulate multiple sign-in methods over
its lifetime without schema friction. A user who signed up with magic-link
later linking their Google account is one Account with one OAuth linkage;
a user who signed up via Google and later sets up a passkey is one
Account with one credential row.

### Provider tag semantics: djibb is its own IdP

The `accounts` table already carries `provider_name` and `provider_client_id`
columns. Their semantics under this ADR are deliberately specific:

- **`provider_name` is the Account's *home identity provider*** — the
  IdP that holds the proof of identity for this Account. Not the most
  recent sign-in method, not a session-level concern. Possible values:
  - `google` → Google holds the identity. We trust their `sub`.
  - `djibb` → **djibb itself** holds the identity. We hold the proof of
    email-control (today via magic-link; tomorrow via passkey, etc.).
  - Future: `apple`, `github`, … one row each.
- **`provider_client_id` is the stable handle within that IdP.**
  - For Google: the `sub` claim.
  - For djibb-as-IdP: the canonical lowercased email at Account creation
    time. (When email-change ships, this column updates with the email
    column.)
- **The sign-in *method* used on a given turn** (magic-link, OAuth
  callback, future passkey) is **session-level metadata**, carried in
  `sessions.flags` as JSON (`{auth_method:'magic_link'}` etc.). It is
  not an Account property.

This framing is forward-looking. djibb is positioned to act as an OAuth-
style identity provider for a future constellation of djibb-built client
apps (djibb.com Pages today; sibling apps later). "Sign in with djibb"
on a sibling app will be exactly the shape "Sign in with Google" is on
djibb today: djibb mints a session, the client gets identity. Magic-link
is the v1 mechanism by which djibb-as-IdP authenticates a user before
handing back identity — directly analogous to Google authenticating with
password / passkey / SMS before yielding a `sub`.

**Schema implication.** A `UNIQUE(provider_name, provider_client_id)
WHERE provider_name='djibb'` partial index prevents two djibb-native
Accounts ever existing for the same email. (Google-home Accounts are
already disambiguated by Google's `sub`, which is unique by construction.)

**Reconciliation with the "Account resolution" section above.** That
section sketches an eventual `oauth_linkages(provider, sub, account_id)`
sibling table — the right shape once an Account accumulates *multiple*
linked providers. v1 keeps everything on the Account row itself:
`provider_name` and `provider_client_id` record the *home* IdP, full
stop. The transition to a sibling table is deferred until the first
Account legitimately needs multiple linked IdPs (e.g., user wants to
add a Google linkage to their previously-djibb-native Account); that
migration is localized to the auth substrate.

### Email-change flow (designed, not built)

Not in v1, but the design supports it cleanly:

1. User initiates: "Change my verified email to `new@x.com`."
2. djibb sends magic-link to `new@x.com` with `purpose = 'verify_email_change'`.
3. User clicks; the consume handler verifies the new address and
   updates `Account.email = 'new@x.com'`.
4. (Optional) a confirmation email goes to the old address.

Because every entity-DO membership and every "shared with me" entry
keys on Account ID, *nothing downstream cares*. The unique constraint
on Account.email is the only place that moves.

### Passkey (deferred, designed)

Schema (sibling to other auth-substrate tables):

```sql
CREATE TABLE account_credentials (
    credential_id TEXT NOT NULL PRIMARY KEY,    -- WebAuthn credential ID
    account_id TEXT NOT NULL,                   -- FK to Account
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,                -- WebAuthn replay protection
    transports TEXT,                            -- JSON array
    device_label TEXT,                          -- user-set ("iPhone 15")
    time_created INTEGER NOT NULL,
    time_last_used INTEGER
);
```

UX shape: signed-in user visits Account settings → "Add a passkey to
this device" → WebAuthn registration ceremony → credential stored.
Future sign-ins detect available passkeys (WebAuthn conditional UI) and
prompt; cancel-or-fail falls back to magic-link/OAuth. Lost passkeys
recover via the email floor.

Deferral rationale: platform UX (Apple iCloud Keychain, Android Google
Password Manager, cross-ecosystem QR pairing) is rough enough that
making passkey *primary* would meaningfully harm sign-in conversion.
Opt-in 2FA gives the security-minded users the uplift without
penalizing anyone else. Revisit the default flip in 12–18 months as
platform UX matures.

## Alternatives considered

### Username/password as a supported method

Rejected. Password adds operational surface — hashing (argon2id parameter
tuning, future migration), breach response (HIBP integration, forced
rotation), lockout & brute-force defenses, a reset flow that is itself
a magic-link with extra UI — without raising the security ceiling
beyond email control. Industry convergence on passwordless (Slack,
Notion, Linear, Vercel) reflects this calculus. Adding password later
is always possible; the architecture deliberately does not anticipate
it.

### Hard email-canonical bijection (option A)

The simpler version of email-as-identity: `UNIQUE(email)` is permanent,
and the Account's identity *is* its email. Rejected because:

- Email-change becomes account-rebuild (lose history, manually migrate).
- Multi-email humans are forced into multi-Account session even when
  their use case is *not* "alt identity" but "I have two email
  addresses for one purpose."
- OAuth `sub` stability is wasted — Google gives us a provider-stable
  ID that survives email changes, and (A) throws it away.

The choice (C) preserves (A)'s schema simplicity *at v1* without
inheriting these constraints downstream.

### Account-ID-canonical with `account_emails` from day one (option B)

Build the `account_emails` sibling table now; one Account, many emails,
multi-email natural. Rejected as premature: djibb's user base today is
small and overwhelmingly single-email-per-human. The schema cost (extra
table, primary-email concept, change-email UI) is real and the gain is
hypothetical. (C) preserves the path to (B) as a localized evolution
when pain materializes.

### Passkey-primary at v1

Sign-in page leads with passkey; magic-link/OAuth are fallbacks.
Modern and security-forward, but the UX cliff for users without an
existing passkey (or on cross-ecosystem hardware) is steep enough to
hurt sign-in conversion. Opt-in 2FA is the conservative path that
gives the same security uplift to users who want it without imposing
"what's a passkey?" prompts on everyone else.

### One Account per (provider, email) pair

The implicit model in some early systems: signing in with Google
`bob@x.com` creates a Google-Account-for-bob; signing in with
magic-link to `bob@x.com` creates a separate magic-link-Account.
Rejected on principle: the Account's identity is *who the user is*,
not *how they happened to sign in*. Two methods to the same email
are two paths to the same person.

## Out of scope

- **SSO / SAML / enterprise IdP integrations.** Future, separate ADR.
- **Phone-number auth (SMS).** Future. The mechanism would parallel
  magic-link, hitting a different identity-kind column.
- **WebAuthn attestation verification.** v1 passkey (when it lands)
  accepts unattested credentials. Attestation is appropriate for
  enterprise contexts and adds substantial verification surface.
- **Account merging.** If two Accounts exist for one human, the
  workaround is multi-Account session; explicit merging is undefined.
- **Forced 2FA / mandatory passkey.** Always opt-in. Mandatory 2FA is
  a deployment-tier concern (enterprise plan, admin-imposed) that
  doesn't apply to djibb's current shape.
- **Step-up / sensitive-action re-auth.** Designed for but not built:
  certain actions (delete Account, change auth method, export data)
  could later require a fresh magic-link confirmation or a passkey
  challenge regardless of session age. v1 ships without this; the
  Account model leaves room.

## Sequencing

1. **Magic-link auth lands first.** D1 migration, request/land/consume
   routes, email send path, sign-in page UI. Unblocks ADR 0009 invitations
   for non-OAuth-provider addresses.
2. **OAuth resolution refactor.** Today's OAuth path implicitly creates
   an Account per provider sign-in. Refactor so that OAuth callback
   resolves by email-match first, falling through to Account creation
   only if no Account exists. Existing single-provider users are
   unaffected.
3. **ADR 0009 (invitations) builds on top of (1) + (2).**
4. **Passkey lands as opt-in 2FA** at some later point, when platform
   UX is judged ready. Pure addition; no auth-floor changes.
5. **Email-change flow** when user demand materializes. Localized
   change to the magic-link substrate.

## Consequences

**Positive:**

- ADR 0009 invitations are deliverable to any email.
- Sign-up funnel widens past Google-only.
- One Account per human, regardless of how many sign-in methods they
  accumulate.
- Schema discipline (Account-ID at contracts, email at matching)
  protects entity DOs from any future auth-substrate change.
- No password operational surface ever enters the codebase.

**Negative / load-bearing:**

- The discipline-rule ("entity DOs key on Account ID, not email") must
  be enforced in code review. A regression that keys `authorized_accounts`
  on email would forfeit the evolution headroom.
- OAuth `email_verified` trust is provider-specific. Adding any
  provider beyond Google requires explicit verification of their
  `email_verified` semantics; untrustworthy claims require a magic-link
  confirmation on first sign-in.
- Email-recycling (a corporate email reassigned to a new employee) is
  a real attack vector against any email-floor system. djibb inherits
  this risk. Mitigation (require recent activity OR fresh OAuth `sub`
  match before allowing sign-in to a dormant Account) is designed but
  not built in v1; reasonable to add when the first incident occurs.

**Neutral:**

- Multi-Account session remains useful for alt-identity scenarios.
- Passkey UX issues are platform-level and outside djibb's control;
  the opt-in stance means djibb is exposed to them only insofar as
  users actively want passkeys.
