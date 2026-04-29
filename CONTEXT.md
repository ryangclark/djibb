# djibb domain context

Living glossary of djibb's domain language. Terms here are the canonical names — code, docs, and UI should match. Update inline as decisions are made.

## Core concepts

### List
The top-level container. A checklist instance owned by a workspace. Schema: `workers/src/list/index.ts::ListSchema`. ID prefix: `l/`. URL: `/l/<suffix>`.

A List holds `ListGroup`s and `ListItem`s arranged hierarchically via `child_element_refs` / `parent_element_ref`.

### ListGroup
A named subsection inside a List (e.g. "Ingredients", "Cookware", "Clothing, Ryan"). Used to organize items. ID prefix: `group/`.

A recipe is **one List with multiple ListGroups** (Ingredients, Roast and concentrate, Finish, etc.) — not multiple Lists. List-of-lists is deferred to v2.

### ListItem
A single checkable thing in a List. Carries name, description, and a `Quantity`. ID prefix: `item/`.

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

**Forking.** A Template can itself carry `forked_from_id` pointing at the Template it was forked from. Same field on both List and Template; the ID prefix discriminates source kind.

**Storage.** Same machinery as a List: a Template lives in its own `DjibbList` DO with the same schema (groups, items, quantities), same Replicache pull/push, same auth middleware. The discriminator is `type: 'list' | 'template'` on the top-level entity (extending the existing `ListElementUnion` which already distinguishes `list | group | item`). `initFromTemplate` is a DO-to-DO copy. This keeps Templates collaboratively editable and offline-capable from day one.

### Workspace
Owns Lists. Every List belongs to exactly one Workspace. See `docs/workspaces.md`. ID prefix: `w/`. URL: `/w/<slug>`.

### Account
An OAuth identity. A user can have multiple Accounts in one session. ID prefix: `a/`. URL: `/a/<suffix>`.

## Homepage (djibb.com client)

### Minted List
The ownerless List that bare `djibb.com` hands an unauthed visitor. Created on first visit, seeded by copying a randomly chosen **Blank** Template from the **Seed Pool**, and persisted via a localStorage pointer keyed to bare-domain visits only (explicit `/l/<id>` visits never read or write the pointer, so shared links don't bounce). The visitor's URL is rewritten to `/l/<id>` on mint so the list is immediately shareable. The List is real in every other respect — DO, Replicache — its `default_role` is literally `ownerless` (collaborative-editable by anyone with the URL; this is exactly what `DefaultRoleEnum` provides), and its `forked_from_id` points at the chosen Blank.

**Sign-in transition: Adopt.** When the visitor signs in, the existing minted List is adopted into their personal Workspace in place — same ID, same URL — rather than forked. Any current collaborators on the link are downgraded to `viewer` rather than locked out. Forking is rejected because it splits the user's mental model into two lists at the exact moment they're claiming ownership of the one they already have.

### Seed Pool / Blanks
The hand-curated set of **Blank** Templates that the Minted List can be seeded from. Curated, not algorithmic, in v1 — controls the tonal range of first impressions.

**The Seed Pool is itself a djibb List.** djibb consumes itself: rather than a SQL table or a hardcoded array, the catalog of Blanks is stored as a real djibb List, edited in djibb.com like any other List. This is a deliberate dogfooding move — the platform's own primitives are the curation tool, and changes to the Blanks happen in the same editor users use. (Open: how each item in the Seed Pool List points at its Blank Template — likely a small extension to ListItem so it can carry an entity reference, but TBD when we wire the mint flow.)

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
