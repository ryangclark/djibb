# djibb domain context

Living glossary of djibb's domain language. Terms here are the canonical names — code, docs, and UI should match. Update inline as decisions are made.

## Design principles

### djibb uses itself
Wherever it's reasonable, internal mechanisms are built out of djibb's own primitives rather than parallel infrastructure. The Seed Pool is a real djibb List, not a SQL table. A Workspace is a DjibbList-shaped DO, not a foreign aggregate. Pending invitations live inside the resource's own DO (filtered out of non-owner pulls) rather than in a separate invitations table. This constraint occasionally bends the design — when it does, the resulting bend is usually generative (it forces unification of concepts that would otherwise sprawl), but it's not absolute. When self-hosting an internal mechanism would meaningfully degrade UX or correctness, fall back to a dedicated mechanism. Default to self-host; deviate consciously.

## Core concepts

### List
The top-level container. A checklist instance owned by a workspace. Schema: `workers/src/list/index.ts::ListSchema`. ID prefix: `l/`. URL: `/l/<suffix>`.

A List holds `ListGroup`s and `ListItem`s arranged hierarchically via `child_element_refs` / `parent_element_ref`.

### ListGroup
A named subsection inside a List (e.g. "Ingredients", "Cookware", "Clothing, Ryan"). Used to organize items. ID prefix: `group/`.

A recipe is **one List with multiple ListGroups** (Ingredients, Roast and concentrate, Finish, etc.) — not multiple Lists. List-of-lists is deferred to v2.

### ListItem
A single checkable thing in a List. Carries name, description, and a `Quantity`. ID prefix: `item/`.

**Optional `references_entity_id` — a soft pointer to another top-level entity.** A ListItem can carry a nullable `references_entity_id` pointing at another top-level entity (a List or Template; prefixes `l/`, `t/`). Sub-elements (`item/`, `group/`) are **not** valid targets — the cascade-delete model (ADR 0008) draws its boundary at the DO, so a reference into another DO's interior would be a dangling-pointer farm waiting to happen. The reference is purely lineage / navigation — checking the local item does **not** propagate to the referenced entity, the same way `forked_from_id` is a soft pointer with no state coupling. State-linking across entities (Secret Santa bubble-up) remains explicitly out of scope as a custom layer, not a core primitive. Existence of the referenced entity is not enforced at write time; dangling references are a read-time concern. Used today by the **Seed Pool** to record Blank membership (each item in the Seed Pool list points at a Blank Template); broadly useful for any cross-entity reference.

**Quantity covers both checkboxes and counts.** `value` and `target_value` are always `number`; the discriminator is `unit`. When `unit === 'boolean'`, the Item is a checkbox represented as bits — `value: 0 → 1` flips it, with `target_value: 1` and bounds `min_value: 0`, `max_value: 1`. When `unit` is anything else (`'tbsp'`, `'gallon'`, `'count'`, etc.), the Item carries an actual count. Completion is universal: an Item is done when `value === target_value`. The existing numeric invariants in `superRefine` apply uniformly — a checkbox is just a count from 0 to 1. This keeps a single Item shape across recipes, packing lists, instructions, and wishlists.

### Template
A reusable, remixable List shape that new Lists can be created from. Distinct entity from List. ID prefix: `t/`. URL: `/t/<suffix>`. Both Lists and Templates carry a nullable `forked_from_id` pointing back to the entity they were created from. The ID prefix on that value (`t/...` vs `l/...`) tells you whether the source was a Template or another List — no separate field needed. No propagation logic in v1; the pointer is bookkeeping for future "self-improving template" features.

**Ownership.** Every Template belongs to exactly one Workspace (including the creator's personal workspace).

**Visibility = `AuthorizationRules.default_role`.** There is no separate `visibility` field. A "public" Template is one whose `default_role` is `viewer` (anyone can read) or `editor` (anyone can remix). A "private" Template uses `default_role: 'restricted'`. Workspace membership resolves above `default_role` (`docs/workspaces.md`). This reuses the same auth model Lists already use — no new concept.

**Editing freedom.** Templates use the same `DefaultRoleEnum` as Lists — including `editor`, which would let anyone with the URL edit the Template directly. That's a real use case ("community-maintained ultimate camping Template") but a footgun for most owners. Schema is permissive; UI defaults are tight (`restricted` or `viewer`) and surface clear warnings when someone opens up edit access.

**Discoverability** is a separate axis from access control, and is secondary in v1. A curated/searchable global catalog over Templates with `default_role !== 'restricted'` can be built later as its own index layer.

We chose "Template" over "Pattern" because it's the word users will reach for unprompted (cf. Notion/Figma/GitHub templates), even though "Pattern" is more evocative of remixability.

### Authorization roles
Every principal resolves to exactly one role per entity — `AuthorizationRules.default_role` for the public, raised by an explicit grant or Workspace membership. Roles are **capability bundles across two independent axes, read and write** — not a single power ladder:

| Role | Read content | Write |
|---|---|---|
| `owner` / `admin` | yes | full (admin = everything but destroy/transfer) |
| `editor` | yes | full structural edits |
| `checker` | yes | check off items only (e.g. mark "purchased") |
| `submitter` | **no** | append new items only (blind submission) |
| `viewer` | yes | none |
| `restricted` | no | none |
| `ownerless` | yes | full (URL-collaborative; the Minted-List default) |

`viewer` (read-only) and `submitter` (write-only / blind append) are duals. Reads are gated at a **view floor**: `restricted` and `submitter` cannot read content; everyone above can. This is how a holding-pen / suggestion-box / Secret-Santa drop stays private *from its own contributors* without leaning on an unguessable id. `checker` and `submitter` are the fine-grained "weird client" roles; the set grows a new bundle only when a genuinely orthogonal capability appears — it is a small lattice, not a tier ladder, and the alternative of a separate per-mutator capability layer stays deferred (ADR 0011 Decision C). (`system` is internal-only: cluster-driven cascade mutations, never a session role.)

Create-List flow: `initList` mutation, then `initFromTemplate` to copy the Template's groups/items into the new List.

**Default state via Template item values.** A Template's items can carry any `value` — including `value === target_value`. When a List is forked from a Template, item values are copied as-is. This means a Template author can pre-check "preheat oven to 375°F" and the forked List starts with it already done. The schema is permissive; the UI may show Template item state differently from List item state.

**Forking.** A Template can itself carry `forked_from_id` pointing at the Template it was forked from. Same field on both List and Template; the ID prefix discriminates source kind. **Forking is content-copy, not reference-linking** (`initFromTemplate` is a DO-to-DO copy); the forked entity owns its content independently of the source. If the source is later hard-deleted (ADR 0008), the forked entity loses nothing but the lineage breadcrumb — read paths treat a missing source as "no lineage to show," not as data loss.

**Storage.** Same machinery as a List: a Template lives in its own `DjibbList` DO with the same schema (groups, items, quantities), same Replicache pull/push, same auth middleware. The discriminator is `type: 'list' | 'template'` on the top-level entity (extending the existing `ListElementUnion` which already distinguishes `list | group | item`). `initFromTemplate` is a DO-to-DO copy. This keeps Templates collaboratively editable and offline-capable from day one.

### Workspace
Owns Lists and Templates. Every List and every Template belongs to exactly one Workspace. See `docs/workspaces.md`. ID prefix: `w/`. URL: `/w/<slug>`.

**A Workspace is itself a djibb entity.** Same DO-backed substrate as List and Template — `DjibbList` is the base class, `DjibbWorkspace` extends it with workspace-specific bits (`is_personal` flag, Island hex coords, the cascade dispatcher from ADR 0008). The top-level `type` discriminator (`list | template | workspace`) names the variant. Workspace membership is, in the long run, an entry in the workspace's own `authorization_rules.authorized_accounts` — the same shape Lists already use — resolving the `@UPGRADE` note in `auth/rules.ts`. `AccountWorkspace` membership rows are a transitional artifact of the prior workspaces-as-D1-rows model. (See "djibb uses itself" under Design principles.)

**Personal vs team.** Every Account has exactly one Workspace flagged `is_personal: true` — the implicit "my stuff" container Lists go into when no team Workspace is involved. Team Workspaces are everything else. The flag is enforced by invariant (exactly one personal per Account), not by URL or routing.

**Deletion (ADR 0008).** Team Workspaces have a "Delete Workspace" verb (modal-confirm, no Cmd+Z); deletion cascade-archives every List and Template the workspace owns through a per-DO alarm dispatcher, each child carrying `cascade_source: w/<id>` and running its own 30-day soft-delete clock before hard-delete. Restore within the window walks the same `cascade_source` predicate to fan out inverses. Personal Workspaces are *not* deletable in the same sense — they expose a **"Start Fresh"** verb instead, which cascade-archives the current personal Workspace and atomically spawns a new one (preserving the "every Account has a personal Workspace" invariant). A personal Workspace restored from Trash while a fresher personal Workspace already exists comes back as a *regular* (non-personal) Workspace, not as a competing personal.

### Account
A verified-email identity with a stable internal ID. A user can have **multiple Accounts in one session** and switch between them in-app (including across browser tabs). ID prefix: `a/`. URL: `/a/<suffix>`.

**Account-ID is the contract boundary; email is the matching key.** Entity DOs key `authorized_accounts` and "shared with me" indexes by Account ID — never by email. Email appears only at *matching* surfaces (sign-in lookup, pending-invite resolution by `(target_id, identity_value)`). Once accepted, a membership refers to the Account ID, which is stable across any future change to the email schema. This discipline is what allows email-attached attributes (number per Account, primary/secondary, change-email flow) to evolve as localized migrations without touching authorization, invitations, or the cascade model. See **ADR 0010**.

**One verified email per Account at v1** — sufficient for the bijection that makes sign-in lookup and invite-target resolution one-row operations. *Not* a permanent commitment: a future `account_emails(email, account_id, is_primary)` sibling table is anticipated for the multi-email-per-human case, and is reachable from v1's schema by adding the table and updating only the auth-substrate lookup paths. Multi-Account-per-session remains the surface for *deliberately separate identities* (alt accounts, personal vs. role-segregated), not for "I have multiple email addresses." See **ADR 0010**.

**Authentication via email-control (ADR 0010).** Magic-link is the auth floor; OAuth (Google today) routes to the same Account when the verified email matches; passkey is opt-in 2FA layered onto an existing Account; password is explicitly excluded. `accounts.provider_name` records the *home identity provider* — `google` means Google holds the identity, `djibb` means djibb itself does (with magic-link as the v1 method of proving email-control). The sign-in *method* used on any given turn lives in session metadata (`sessions.flags`), not on the Account. This framing positions djibb to act as an OAuth-style IdP for future djibb-built client apps — sibling apps "Sign in with djibb" the way djibb signs in with Google today.

### Principal
**Who a request resolves to** at the request→Account seam — the single value every client funnels into before authorization runs. Modeled as the `RequestPrincipal` discriminated union (`packages/server-cf/src/auth/principal.ts`): `anonymous`, `session` (an interactive cookie sign-in, multi-Account), or `credential` (a non-interactive bearer token, single-Account; **ADR 0022**). The two authed arms share an `accounts` field (the Accounts the request may act as); each carries only its own distinguishing data — `sessionId` for the cookie-merge flow, `credentialId` + `boundEntityId` (and, later, a role ceiling) for the forward-threaded constraints the seam itself cannot enforce.

A Principal is the *authentication* result; it then flows unchanged into ADR 0021's single `(Account, entity) → role` *authorization* model. **Session and credential are siblings, not subtypes** — different substrate (`sessions`/`AccountSession` vs `issued_credentials`), lifecycle (session revoke deletes the row; credential revoke is retained soft-state), and cardinality — converging only at this seam. Adding a "weird client" (email-reply, a standing bot) is a new way to *produce* a Principal, with no change to any downstream reader. `resolvePrincipal` is the one adapter from the substrate return types into the union; the substrates stay ignorant of it. See **ADR 0022** §2.

### Invitation
An outstanding grant-of-access waiting to be claimed. Issued by an authorized member of a djibb entity (List, Template, or Workspace) to invite another party — identified by email — to that entity. Carries a target role, an expiry, and the invitee's email. When the recipient is signed in to djibb under that verified email, they can claim the invitation, which adds them to the entity's `authorization_rules.authorized_accounts` at the invited role.

**Tokenless: auth and authorization are independent steps.** The invite-notification email contains only a next-URL, not a bearer token. Identifying the recipient is the auth layer's job; the invitation just records "this email may claim this role on this entity." Forwarding is harmless — the forwardee can't sign in as someone else's email. Bearer-token share links ("anyone with this URL") are a *different primitive* (provisionally **Share Link**), not folded in.

**DO-resident, authoritative.** Pending invitations live inside the target entity's own DO ("djibb uses itself"), keyed `pending_invites/<lowercased_email>`. A thin D1 index answers "what's pending for me?" across DOs and powers cross-DO rate limits. Accept is one atomic DO mutation; no two-phase commit.

**Revoke vs Remove are different verbs.** Revoke kills a pending Invitation (low friction, no Cmd+Z). Remove access drops an accepted Membership entry from `authorized_accounts` (goes through `setListAuthRules`, inverse-backed, Cmd+Z works).

See **ADR 0009** for the full design — PII gating via pull filter, D1 derived index shape, three target types, entity-vs-workspace grant axis independence, "shared with me" indexing, and the sequencing dependencies on Workspace-as-DO and magic-link auth.

## Homepage (djibb.com client)

### Minted List
The ownerless List that bare `djibb.com` hands an unauthed visitor. Created on first visit, seeded by copying a randomly chosen **Blank** Template from the **Seed Pool**, and persisted via a localStorage pointer keyed to bare-domain visits only (explicit `/l/<id>` visits never read or write the pointer, so shared links don't bounce). The visitor's URL is rewritten to `/l/<id>` on mint so the list is immediately shareable. The List is real in every other respect — DO, Replicache — its `default_role` is literally `ownerless` (collaborative-editable by anyone with the URL; this is exactly what `DefaultRoleEnum` provides), and its `forked_from_id` points at the chosen Blank.

**Sign-in transition: Adopt.** When the visitor signs in, the existing minted List is adopted into their personal Workspace in place — same ID, same URL — rather than forked. Any current collaborators on the link are downgraded to `viewer` rather than locked out. Forking is rejected because it splits the user's mental model into two lists at the exact moment they're claiming ownership of the one they already have.

### Seed Pool / Blanks
The hand-curated set of **Blank** Templates that the Minted List can be seeded from. Curated, not algorithmic, in v1 — controls the tonal range of first impressions.

**The Seed Pool is itself a djibb entity (List or Template).** djibb consumes itself: rather than a SQL table or a hardcoded array, the Seed Pool is a real djibb entity with its own page in djibb.com, edited like any other. Dogfood by design — the platform's own primitives are the curation tool.

**Membership is via items in the Seed Pool list.** Each ListItem in the Seed Pool carries a `references_entity_id` pointing at a Blank Template. To pick a random Blank for a mint: read the Seed Pool's items, choose one at random, follow its `references_entity_id`. Adding/removing a Blank from the catalog = adding/removing an item in the Seed Pool list, edited like any other djibb list. Blanks themselves are standalone Templates — they do **not** point at the Seed Pool via `forked_from_id`; the catalog relationship is one-directional from Seed Pool → Blanks via item references, not the other way around.

**The Minted List's lineage points at the Blank, not the Seed Pool.** When a List is minted, its `forked_from_id` is set to the chosen Blank's id (`t/...`). The Seed Pool is a catalog, not part of the lineage chain — it's the curator's index, not an ancestor of the entities it indexes.

### Island
The hex-map UI surface for a Workspace's Lists on authed `djibb.com`. Each hex is one List; position is algorithmic and stable, not user-placed; terrain is a function of List content, not preference; chrome is light. The Island *grows* with usage rather than being composed — manual rearrange and list-of-lists views are deliberate non-features.

The depth — terrain rules, hex visuals (completion + recency axes), Dock affordance, hexes-cluster-by-terrain, hole-as-ocean deletion, empty-ocean onboarding — lives in **`docs/island.md`**.

## Use cases anchoring the model

Three canonical use cases (`docs/use-cases.md`): recipe, camping pack checklist, secret santa. Diverse on purpose — proves a single List primitive can power very different frontends.

## Engineering process docs

Conventions and how-to guides for working in this codebase live in `docs/` — read the relevant one before writing new code in the matching area:

- `docs/testing.md` — test surface choices (vitest vs E2E), dev-seam pattern, pure-predicate pattern, agent-browser conventions, operational gotchas.
- `docs/adding-a-mutator.md` — checklist for new Replicache mutations (paired forward/inverse, ADR 0005).
- `docs/workspaces.md` — workspace membership model.
- `docs/keymaps/` — keyboard interaction conventions.
- `docs/adr/` — architectural decision records.

## Deferred / out of scope for v1

- **Multi-Template composition** ("car camping" + "Lewis" + "Moab April" merged into one List): v2. v1 is single-source instantiation; users build composed Templates by forking instead.
- **Cross-list item identity** (Secret Santa "mark purchased here, bubble up everywhere"): custom layer on top of djibb, built using DO-to-DO calls + existing websockets. Not core djibb.
- **Per-field visibility within a single entity** (hiding one column of an item from a reader who can see the rest): still frontend-only. But the canonical Secret Santa case — "Purchased" hidden from the recipient — is now backend-enforceable by **decomposition**: model purchase-state as its own entity the recipient holds `restricted` on, and the read view-floor (see *Authorization roles*) enforces it. Only hiding a field of an entity the reader can *otherwise* read stays cosmetic/deferred.
- **Pattern parameters / computed quantities** ("2 nights → 4 underwear"): v2.
- **Template propagation to existing Lists** (Template edits flowing into Lists already created from it): not in v1. Templates are pure-copy at instantiation; the "self-improving" loop is just *the user editing the Template, and the next instantiation benefiting*. The `template_id` pointer leaves the door open for soft propagation later.
- **"Consumables" / next-time-only Template state** (e.g. "we ran out of fuel — top up on the next trip but don't permanently increase the quantity"): a real, lived tension. Related to Templates but doesn't fit at the same time as them. Possibly a future "consumables" section, possibly a Secret-Santa-style cross-list bubble-up. Not solved.
- **List-of-lists / hierarchical Lists**: v2; for now, use plain links between Lists if needed.
