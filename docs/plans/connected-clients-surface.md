# Connected-clients access surface — locked field/button set

> Findings from the GH #19 throwaway prototype
> (`apps/djibb-com/src/routes/prototype/connected-clients/+page.svelte`).
> ADR 0022 §6 ("the access surface is the grant-axes union, rendered by a
> client"). This doc is the **design decision** the issue asks for: it fixes
> the columns and actions the powering slices (#4 credentials D1 projection,
> #5 the read/serve path) and the real build (#6b) must implement. The
> prototype itself is disposable — delete the route once #6b lands.

## What the surface is

One roster of **everything that can act on an entity**, unioned from the
independent grant axes ADR 0009 named plus credentials. Three concrete row
**types** appear; they come from two different substrates plus the existing
member roster:

| Type      | Source                                   | "Acts as"                  | Revoke means        |
| --------- | ---------------------------------------- | -------------------------- | ------------------- |
| `session` | `sessions` / `AccountSession` (§4)       | the signed-in human        | sign that client out |
| `token`   | `issued_credentials` (§4)                | the Account it was minted for | revoke the token  |
| `bot`     | a member row whose Account is non-human (§3) | its own Account        | remove the member   |

The union is the load-bearing idea: sessions and tokens live in **separate
substrates**, and bots are already roster rows, so the surface stitches three
reads together rather than one table.

## Locked per-row field set

Columns are shared across types where they make sense; a few are type-specific
(noted). This is the inventory #4/#5 must serve.

| Field            | session | token | bot | Notes |
| ---------------- | :-----: | :---: | :-: | ----- |
| **type badge**   | ✓ | ✓ | ✓ | Disambiguates the three sources at a glance. |
| **label**        | device/client ("Chrome · macOS") | the credential `label` | bot display name | First thing a human reads. Sessions have no stored label today — derive from user-agent at display time (see open question). |
| **acts as**      | ✓ | ✓ | ✓ (= itself) | Account-ID-keyed (ADR 0010); render display name, not the id. |
| **scope / bound**| whole account | `bound_entity_id` or "whole account" | whole account | Only tokens carry a binding (§4). Prefix-agnostic id; render the entity's name when resolvable. |
| **last used**    | ✓ | `time_last_used` (throttled, §4) | last attributed mutation | Tokens' value is best-effort/throttled — surface "~" or relative time, never imply exactness. |
| **created**      | ✓ | `time_created` | member-since | — |
| **expires**      | ✓ | `time_expires` or "never" | n/a (—) | Sessions expire; non-expiring tokens read "never"; bots have no expiry. |
| **state**        | active | active / expired / revoked | active | Drives the history view; active rows only in the main roster. |

Dropped from the guess: a separate "id" column (the label + type badge carry
identity; the raw `credential_id` belongs in a details/hover, not a column) and
per-row "kind" beyond the three-type badge (the substrate is the type).

## Locked action inventory

- **Revoke** (per active row). Label is **"Revoke"** for sessions/tokens,
  **"Remove"** for bots (it's a member removal, different blast radius). Always
  confirm. After action the row leaves the active roster and reappears under
  history (tokens/sessions) or is gone (bot membership).
- **Credential history** — a collapsed toggle showing revoked/expired rows.
  Retained, not deleted: revoked/expired credentials stay queryable for audit.
  Read-only (no un-revoke).
- **Mutation-log attribution** — not an action, a *render rule* on the existing
  log (§5): an entry authored under a token reads **"<Account> <action> · via
  <label>"**; a plain session entry just reads **"<Account> <action>"**. This is
  the consumer of the `credential_id` already threaded through the push envelope
  in #22 — the log joins `credential_id → label` to render the "via" clause.

## Hand-off to the powering slices

> **Update (GH #23, resolved):** the "credentials D1 projection" reduced to a
> **union read**, not an ADR 0003 emit. Credentials and sessions are both
> *natively* authoritative in D1 (`issued_credentials` is written directly by
> `CreateCredential`; sessions live in `sessions`/`AccountSession`) — neither
> originates in a Durable Object, so there is nothing to project. ADR 0003
> governs DO-owned *entity* data only; it isn't contradicted, it just doesn't
> reach auth-substrate tables. So #23 shipped as `src/auth/connected.ts`
> (`ListConnectedClients` + `partitionConnectedClients`) with no new table, no
> emit, no reconciler. See the `## Substrate note` below.

- **#4 (credentials D1 projection)** must project at least:
  `credential_id, label, account_id, bound_entity_id, time_created,
  time_last_used, time_expires, time_revoked`. That is exactly the
  `issued_credentials` column set from migration 0015 — the projection is a
  straight ADR 0003 emit, no new fields invented here. The mutation-log "via"
  render needs `credential_id → label`, so the projection (or the log read)
  must make `label` reachable from a `credential_id`.
- **#5 (read/serve path)** serves the **union of three reads**, filtered to the
  viewer's manage scope, partitioned active vs. history by `state`. Sessions and
  the bot roster are separate reads joined client-side or in the handler — not
  the credentials projection.
- **#6b (real build)** replaces the mock route with live reads and wires the
  three buttons to real revoke/remove mutators. The field/column set and button
  labels above are the contract.

## Open questions surfaced (decide during #4/#5, not blockers)

1. **Session labels.** Sessions have no stored label today; "Chrome · macOS" in
   the prototype is invented. Either derive from user-agent at display time
   (cheap, no schema change) or store a label on the session (heavier). Lean
   derive-at-display unless a real need appears.
2. **Name resolution.** "Acts as" and bound-entity want display names, not ids.
   The members projection already resolves Account names; bound entities need an
   entity-name lookup the surface doesn't have yet. Acceptable to ship #6b with
   id suffixes (as the audit log does today) and resolve names as follow-up.
3. **Scope of "connected to what".** The prototype frames the roster around a
   workspace. A token bound to a single list, or an unbound account-wide token,
   blurs "connected to this entity" vs. "connected to my account". #5 should
   decide whether the surface is per-entity, per-account, or both with a filter.
   The #23 read leaves this to the caller: it takes `accountIds` (Account-keyed,
   because both substrates are) plus an optional `entityId` that narrows tokens
   to unbound + bound-to-it. The entity surface resolves member Accounts via
   `entity_memberships` and passes them in.

## Substrate note (why #23 is a read, not a projection)

The connected-clients union touches two principal substrates that are **both
natively authoritative in D1**:

- `sessions` ⋈ `AccountSession` — interactive sign-ins.
- `issued_credentials` — bearer tokens, written directly to D1 by
  `CreateCredential` (GH #16).

`entity_memberships` / `entity_invitations_index` are ADR 0003 *projections*
because their sources (`authorization_rules`, `pending_invites`) live inside
Durable Objects, and a DO can't be queried cross-entity — the D1 index is how
DO-owned data becomes cross-cuttingly readable. Credentials and sessions have
no DO origin, so there is nothing to emit or reconcile: D1 *is* the source of
truth. ADR 0003 isn't weakened by this — it governs DO-owned **entity** data;
auth-substrate tables (`accounts`, `sessions`, `magic_link_tokens`,
`issued_credentials`) have always been written to D1 directly and sit beside
that model. The third row type, **bot member-Accounts**, stays out of this read
— a bot operates its own Account and appears via the membership roster, which
*is* an ADR 0003 projection. #24 composes the two.
