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

**Authentication methods (ADR 0010).** Magic-link is the auth floor — passwordless, one-time email-bound tokens minted via the existing `workers/src/email` path. OAuth (Google today; others vetted case-by-case for `email_verified` trustworthiness) routes to the same Account when the verified email matches; the provider becomes session metadata, not Account identity. Passkey is opt-in 2FA layered onto an existing Account, sequenced after magic-link ships. Password is explicitly excluded — it adds operational surface without raising the security ceiling beyond email control.

### Invitation
An outstanding grant-of-access waiting to be claimed. Issued by an authorized member of a djibb entity (List, Template, or Workspace) to invite another party — identified by email — to that entity. Carries a target role, an expiry, and the invitee's email. When the recipient is signed in to djibb under that verified email, they can claim the invitation, which adds them to the entity's `authorization_rules.authorized_accounts` at the invited role.

**Tokenless: two independent steps, not a bearer flow.** An email invitation does *not* carry a single-use accept token. A token would only be needed to identify the recipient — and we already know them. Instead the flow factors into:

1. **Authentication** (djibb's general auth layer). Recipient signs in with a verified-email path (OAuth today; magic-link in future). Output: a session whose Account is bound to verified email `E`. This step is identical to any other sign-in.
2. **Authorization** (the invitation system). When the signed-in user visits the target entity or their invitations inbox, the system checks "is there a pending invite for any of this account's verified emails on this entity?" If yes, surface an Accept affordance.

The invite-notification email contains only a next-URL (link to the entity, or to `/invitations`); it is **not** an authentication token and **cannot** be claimed by a forwarder. Forwarding is harmless — the forwardee can't sign in as `E` unless they actually control `E`.

**Bearer-token share links are a different primitive.** "Anyone with this URL can join as viewer" *is* an invite-someone-we-don't-know flow, where a bearer token is doing real work. That's a separate concept (provisionally **Share Link**) — different table, different UI affordance, different mental model. Not folded into email invitations.

**DO-resident, authoritative.** The pending invitation lives inside the target entity's own DO, in a `pending_invites/<lowercased_email>` namespace, *not* in a parallel D1 table. Self-host follows "djibb uses itself" — and because the invite, once accepted, mutates the same DO's `authorized_accounts`, accept is one atomic DO mutation rather than a two-phase D1+DO commit.

**PII gated by pull filter.** Invite records carry the invitee's email. The DO's Replicache pull handler strips `pending_invites/*` keys for any subscriber whose role is not in `OWNER_ROLES`. The pull cookie must encode role-version so promotion/demotion triggers fresh patches; demotion emits `op: 'del'` for the previously-visible keys. The D1 read-index emit does not include invite emails.

**D1 derived index.** A thin `entity_invitations_index(target_id, target_email, target_type, role, inviter_account_id, time_created, time_expires)` table, derived (ADR 0003) from DO state, exists to answer (a) "what invitations are pending for verified email `E`?" without scanning every DO, and (b) cross-DO per-inviter rate limits. No tokens; the email is the join key. Cascade-delete of a target DO deletes its index rows in the same batch.

**Same machinery, three target types.** A workspace invite and a list/template invite are the same primitive pointed at different `type` of DO. The existing `workspace_invitations` table predates this model; it remains as a transitional surface until the unified DO-resident path lands, then retires.

**Entity and Workspace are independent grant axes.** Accepting an entity invite grants access to *that entity only* — no implicit Workspace membership, no special case for personal-Workspace-owned entities. Bob accepting an invite to "Weekend BBQ" in Alice's personal Workspace does not become a member of Alice's personal Workspace. Workspace membership and entity membership are union-composed at auth time (entity-direct grant ∪ workspace-member implicit grant per the `@UPGRADE` direction in `auth/rules.ts`).

**Revoke vs Remove are different verbs on different records.** *Revoke* operates on a pending Invitation — invalidates a token-less, not-yet-acted-on grant. Low friction (re-invite is cheap), no Cmd+Z. *Remove access* operates on an accepted Membership — an entry in `authorized_accounts`. Goes through the existing `setListAuthRules` mutator pipeline (inverse-backed, Cmd+Z works). Once an Invitation transitions to `accepted`, it is no longer an Invitation — the membership is the live object, and the invitation row is retained only as audit (`time_accepted` populated). The Share UI exposes both verbs on different surfaces: Revoke on the "Pending invitations" section, Remove on the "People with access" roster.

**"Shared with me" is a D1 derived index at v1.** A small `account_authorizations(account_id, target_id, target_type, role, time_granted)` table, emitted from entity DOs (ADR 0003 style) on grant/revoke, powers the user's view of entities they've been granted on across all DOs. This is a deliberate v1 simplification: the end-state is for `Account` to itself be a `DjibbList`-shaped DO whose items carry `references_entity_id` to shared entities — making "shared with me" a real djibb list per the "uses itself" principle. That refactor is sequenced *after* Workspace-as-DjibbList lands and is a swap-the-source migration that does not disturb the auth model. The v1 D1 index's columns mirror what the future account-list items will carry, so nothing paints into a corner.

See **ADR 0009** for the full design (target-binding decomposition, alternatives considered, sequencing dependencies on Workspace-as-DO and magic-link auth).

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
The visual representation of a Workspace's Lists for an authed visitor — a hex map where each hex is one List. Bare `djibb.com` (authed) renders the **personal** Workspace's Island; team Workspaces eventually get their own Islands at `/w/<slug>`. List-of-lists views are explicitly rejected as the primary view.

**Growth, not composition.** The Island grows as Lists are created — one new hex per new List, no pre-sized board, no empty hexes. Hex position is algorithmic and stable (deterministic from List ID / creation order), not user-placed. There is no manual drag-to-rearrange in v1. This is intentionally "pull, not push": the user doesn't decide where a List goes; the Island reflects their usage rather than their decorative taste. Spatial memory still works because positions are stable, the same way Catan boards are randomized but memorable once set.

**Terrain reflects content, not preference.** Each hex's terrain (biome, color, art) is a function of its List's properties (seed Template, age, tags, group count, etc.) locked in at hex-creation time. Terrain is therefore *legible* — recipes cluster as one biome, camping lists as another — not arbitrary decoration. Fallback terrain is required for content-poor Lists ("Untitled, zero items").

**Workspaces become the organizing tool.** Because each Workspace has its own Island and the user can't manually arrange, the way to make your maps reflect a meaningful grouping is to create Workspaces for those groupings. The composition lever is at the Workspace layer, not the hex layer.

**Hex visuals carry two state axes, locked-in semantics.** Beyond identity (terrain = content type, label = name), a hex visibly reflects two universal state axes: **completion** (% of items done) and **recency** (how long since last touched). The encoding is consistent across every terrain — e.g. completion always reads the same way, recency always reads the same way — so the map functions as an ambient dashboard rather than just a navigation surface. Other axes (collaborator count, etc.) are deferred; two channels keeps the visual language legible. State and terrain are separate channels: a recipe looks like a recipe whether 0% or 100% done.

**Chrome is light edge-only; creation is an Island gesture.** djibb.com (authed) is full-bleed Island. The only persistent chrome is a top-right cluster with the account avatar (which exposes workspace switcher and account menu). Creating a new List is *not* a top-bar button — it's a dedicated **Dock** affordance on the Island itself (a lighthouse-like hex on the perimeter), which physicalizes the Island's growth: tapping the Dock spawns a new hex adjacent to it. The Dock is the single visible affordance in the empty-ocean state, giving a brand-new user exactly one thing pulling them in. The workspace switcher renders other Workspaces as thumbnails of *their* Islands, extending the map metaphor to the picker.

**Hex interaction is hybrid: quick-tray + full view.** Hover (or first tap on mobile) opens an inline tray on the hex showing title, status, and a short stack of unchecked items that can be checked off without leaving the map — this is the "mark one thing done in passing" path that fits djibb.com's accessory-sail frame. A click on the hex's open affordance routes to `/l/<id>` for the full List view, which remains the canonical, shareable surface. Pure inline-only is rejected because shareable URLs require a standalone route to exist anyway. Implication: the map lazily subscribes to the contents of visible Lists (not just labels) — affects perf at high List counts.

**Hexes cluster by terrain, with a spiral fallback.** A new List's hex prefers an open slot adjacent to an existing hex of the *same* terrain (i.e. same content type). When no same-terrain neighbor exists yet, the hex falls back to the next slot in a deterministic spiral anchored at the origin hex. The first hex ever sits at origin. The rule composes with terrain-from-content to produce *biomes* — recipe regions, camping regions, etc. — whose existence on the Island reflects actual usage. Lakes (interior holes from deletions) are preferentially paved over by same-terrain successors, which lets the Island self-heal without ever moving an existing hex. Terrain classification must be coarse enough (a small fixed set of biomes) for clustering to do real work.

**Deletion is hole-as-ocean.** When a List is deleted, its hex becomes water — ocean if on the perimeter (the Island shrinks on that edge), a lake if interior. Neighboring hexes never move. This preserves spatial memory absolutely and gives the Island a shape that records the user's history of removals, not just additions. Archive is offered alongside delete as a softer alternative (hex stays, low-saturation/fogged, restorable); true deletion is reserved for the user who actually wants the List gone.

**Empty ocean for zero-List users.** A brand-new authed user with no Lists sees a deliberately empty ocean — beautiful, ambient, with at most a single unobtrusive create affordance. No starter hex. The "your Island reflects your usage" invariant is preserved by refusing to seed it with anything the user didn't make. The expected onboarding path makes this rare: bare `djibb.com` unauthed → Minted List → Adopt on sign-in means most new users land on a one-hex Island that already feels theirs.

## Use cases anchoring the model

Three canonical use cases (`docs/use-cases.md`): recipe, camping pack checklist, secret santa. Diverse on purpose — proves a single List primitive can power very different frontends.

## Deferred / out of scope for v1

- **Multi-Template composition** ("car camping" + "Lewis" + "Moab April" merged into one List): v2. v1 is single-source instantiation; users build composed Templates by forking instead.
- **Cross-list item identity** (Secret Santa "mark purchased here, bubble up everywhere"): custom layer on top of djibb, built using DO-to-DO calls + existing websockets. Not core djibb.
- **Per-viewer field visibility** (Secret Santa "Purchased" column hidden from owner): frontend-only.
- **Pattern parameters / computed quantities** ("2 nights → 4 underwear"): v2.
- **Template propagation to existing Lists** (Template edits flowing into Lists already created from it): not in v1. Templates are pure-copy at instantiation; the "self-improving" loop is just *the user editing the Template, and the next instantiation benefiting*. The `template_id` pointer leaves the door open for soft propagation later.
- **"Consumables" / next-time-only Template state** (e.g. "we ran out of fuel — top up on the next trip but don't permanently increase the quantity"): a real, lived tension. Related to Templates but doesn't fit at the same time as them. Possibly a future "consumables" section, possibly a Secret-Santa-style cross-list bubble-up. Not solved.
- **List-of-lists / hierarchical Lists**: v2; for now, use plain links between Lists if needed.
