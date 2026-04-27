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
