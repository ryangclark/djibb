# What a ListItem can carry today, and what wishlist fields need

Research for GH #77 (map: GH #76, Secret Santa client v1). Audited at commit `46b78d844` (main, 2026-10-11).

All claims below were read from source at that commit. Nothing was executed: no test was run and no mutation was pushed against a DO. Where a statement is an inference from the code, it is marked "inferred".

`docs/research/` is a new directory; the repo had no existing home for research notes.

## Answer in brief

A ListItem carries exactly two free-text fields (`name`, `description`), one `Quantity`, and one nullable string pointer. There is no metadata or extension field on an item. So a wishlist row's name and notes fit as-is; URL, price and size/colour fit only as a client convention packed into `description` (or `name`); a typed price, a typed URL, per-item metadata, or child items under an item all need a protocol change.

Quantity already allows an unbounded, open-ended count, and several people can count toward one target, but there is no atomic increment: it is whole-value replace with optional compare-and-set.

Three gaps surfaced that the wishlist design has to route around or fix (see "Gaps found").

## The ListItem shape

`ListItemSchema` (`packages/protocol/src/list/index.ts:307-324`):

| Field | Type | Writable after create |
|---|---|---|
| `name` | `z.string()`, no length cap (`index.ts:310`) | yes, `setItemFields` |
| `description` | `z.string().optional()`, no length cap (`index.ts:308`) | yes, `setItemFields` |
| `value` | `QuantitySchema` (`index.ts:322`) | yes, `setItemFields` or `setItemQuantity` |
| `references_entity_id` | `z.string().nullable()` (`index.ts:317`) | yes, `setItemFields` |
| `parent_element_ref` | `z.string()` (`index.ts:311`) | yes, `setItemFields` (cross-parent move) |
| `id`, `type`, `time_*`, `version` | system | no (`setItemFields.ts:17-21`) |

The writable surface is closed. `setItemFields` and `setItemsAtomic` accept only `description`, `name`, `parent_element_ref`, `references_entity_id`, `value`, and the schema is `.strict()`, so an unknown key fails the args parse (`setItemFields.ts:23-32`, `setItemsAtomic.ts:21-30`) and the mutation is skipped (`mutators/index.ts:292-299`). `createListItem` takes a full `ListItemSchema` (`createListItem.ts:11-13`), which is a non-strict `z.object`, so unknown keys are silently dropped rather than stored (inferred from Zod's default strip behaviour; the storage table has no column for them either, `packages/server-cf/src/list/sql.ts:569-588`).

### No extension field on items

`meta` (an open JSON bag) exists only on entity rows: List, Template, Workspace (`index.ts:114-129`). The storage column is commented "entity rows only" (`sql.ts:576`). `ListItemSchema` and `ListGroupSchema` have no `meta` (`index.ts:238-249`, `307-324`).

Even at entity level, the only mutator that writes `meta` is `setWorkspaceImage`, which is owner/admin-gated and writes `meta.image_url` (`setWorkspaceImage.ts:17`, `:50`); every list-creating mutator sets `meta: null` (`initList.ts:146`, `mintFromBlank.ts:108`, `initFromTemplate.ts:93`). So a client cannot stash wishlist-level settings in a List's `meta` today either.

### Inline markdown (PR #75)

`renderInlineMarkdown` lives in `@djibb/client` and is display-only; stored strings are untouched (`packages/client/src/inlineMarkdown.js:1-8`). Supported: bold, italic, code, and `[text](url)` for http/https/mailto only (`inlineMarkdown.js:10-14`). No block markdown, images or raw HTML (`inlineMarkdown.js:16-18`).

djibb.com applies it to item names, group names and the list description (`apps/djibb-com/src/lib/components/List.svelte:656`, `:692`, `:799`). djibb.com does not render an item's `description` anywhere in that component (the only `.description` reads are the list's, `List.svelte:510`, `:797`). So anything a wishlist client puts in an item description is invisible, not garbled, when the same list is opened on djibb.com. A link placed in the item `name` is clickable in both clients.

## Quantity bounds

`QuantitySchema` (`index.ts:254-302`):

- `target_value`, `value`, `unit` are required; `max_value` and `min_value` are optional (`index.ts:256-260`).
- **`target_value` cannot be absent.** It is a required `z.number()` (`index.ts:258`). There is no "no target" state. Zod is 4.4.3 (`package-lock.json:5815-5816`), whose `z.number()` rejects `Infinity` (inferred from Zod 4 behaviour, not tested here), so "unbounded target" cannot be spelled as an infinite target either.
- **`max_value` can be absent, which makes the count unbounded above.** Every upper-bound check sits inside `if (max_value !== undefined)` (`index.ts:267-286`).
- **A count can exceed its target** when `max_value` is absent or higher than the target. The only relations enforced are `value <= max_value`, `target_value <= max_value`, `min_value < max_value`, `min_value <= value`, `min_value <= target_value` (`index.ts:268-300`). Nothing compares `value` to `target_value`.
- No integer or non-negative constraint: fractional and negative values pass unless `min_value` is set.
- `unit` is any string (`index.ts:259`). Completion is `value === target_value` by glossary convention (`CONTEXT.md:27`) and in the markdown encoder (`packages/protocol/src/list/markdown.ts:164-167`); an over-target count therefore reads as "not done" to any client using that rule.
- The markdown/JSON content encoding drops bounds: `MarkdownQuantity` carries only `value`, `target_value`, `unit` (`markdown.ts:36-41`).

### Several people counting toward one target

Possible, with caveats.

- `setItemQuantity` replaces the whole Quantity object (`setItemQuantity.ts:49-53`; `sql.ts:1404-1424`). There is no increment mutator. Two givers who each read 1 and write 2 land on 2, not 3, unless they pass `expected`.
- With `expected: { quantity }` the server compares the stored value and returns `stale` on mismatch without writing (`setItemQuantity.ts:39-48`). A client can retry on `stale`. Forward UI calls do not send `expected` today (`setItemFields.ts:43-44`), so this is a pattern the new client would have to adopt.
- Role gate is `EDIT_ROLES`: owner, admin, editor, checker, ownerless (`setItemQuantity.ts:33`, `_shared.ts:19-25`). A `viewer` cannot change a count.
- An item records no author. There is no `created_by` or per-increment attribution on `ListItemSchema` (`index.ts:307-324`), so a shared counter says how many, never who.

Design consequence (inferred, from ADR 0027): the giftee's wishlist is never mutated by a purchase and givers are `viewer` on it (`docs/adr/0027-read-secrecy-via-entity-decomposition.md:124-126`, `:135-136`). So "several givers buy toward one open-ended item" is not a Quantity on the wishlist item at all; the count lives on the hidden Claims entity. There the collision-free form is one appended claim row per giver (`createListItem`), with the taken-count being the number of live claim rows, rather than a shared counter everyone overwrites.

On the wishlist side, the Quantity can still express "how many I want": `target_value: N`, no `max_value` for open-ended.

## `references_entity_id`

- Schema: any string or null (`index.ts:312-317`). No prefix check, no existence check, at create or update (`createListItem.ts:43`, `sql.ts:1509-1512`, `sql.ts:1747-1769`).
- Documented contract: a soft pointer to a top-level entity (`l/`, `t/`); `item/` and `group/` ids are "not valid targets"; no state propagation; dangling references are a read-time concern (`CONTEXT.md:25`).
- So pointing at an item in another entity is not rejected by code but is outside the documented contract. No server code reads the field beyond storing it (grep of `packages/server-cf/src` finds it only in `list/sql.ts`); djibb.com treats it as an entity link (`List.svelte:695-696`, `apps/djibb-com/src/routes/+page.svelte:58`), so an item id there would render as a broken entity link on djibb.com (inferred).
- One pointer per item. It cannot hold both "which wishlist" and "which item".

This matters for ADR 0027, which says each claim is "an item carrying `item_ref → X.item_id` and `claimed_by`" (`docs/adr/0027-read-secrecy-via-entity-decomposition.md:128-129`). Neither field exists on `ListItemSchema`, and no code mentions them (grep for `item_ref` / `claimed_by` across `packages/` returns nothing). Claim rows are therefore also a client convention today: e.g. `references_entity_id` = wishlist entity id, wishlist item id in `name`, claimer in `description`. A client-written `claimed_by` is self-asserted, not server-attested.

## Nesting

- **Items cannot have child items.** `ListItemSchema` has no `child_element_refs` (`index.ts:307-324`); only entities and groups do (`index.ts:106`, `:239`). The client mutator rejects a parent that is not a list, template or group (`createListItem.ts:67-73`). The markdown model says so directly: an indented bullet "is a sub-item, which the model doesn't have yet" and is folded into the parent item's description (`markdown.ts:285-288`).
- The server half of `createListItem` does not check the parent's type; it appends to whatever row `parent_element_ref` names (`createListItem.ts:43-44`, `sql.ts:1808-1843`). Sending an item id as parent is unvalidated, not supported: the item row's `child_element_refs` would be written but is not part of the item schema.
- **Groups nest**, five levels deep (depth 0 to `MAX_DEPTH = 4`, `markdown.ts:94`; enforced on write, `groupDepth.ts:1-12`, `initList.ts:157-166`). "Dress shirts" as a group with one item per variety is the supported shape.
- **But there is no mutator that creates a group after the list exists.** The mutator registry has archive, unarchive, reorder and set-fields for groups and no create (`mutators/index.ts:93-129`); `sql.ts:1779-1781` states "there is no standalone `createListGroup` mutator yet". Groups are written only inside `initList` (`initList.ts:64`, `:172-174`) and `mintFromBlank` (`mintFromBlank.ts:134`). `setGroupFields` can move or rename an existing group but not make one.

## Classification

| Wishlist need | Verdict | How |
|---|---|---|
| Item name | Fits as-is | `name` (`index.ts:310`) |
| Free notes | Fits as-is | `description` (`index.ts:308`), set via `setItemFields`, not at create (see Gap 1) |
| "How many I want", incl. open-ended | Fits as-is | `value` with `target_value: N`, omit `max_value` (`index.ts:256-286`) |
| URL | Client convention only | Markdown link in `name` (clickable on djibb.com too) or a line in `description`. No typed URL field, no validation. |
| Price | Client convention only | A line in `description`. `Quantity` is one-per-item and is the want-count; using it for price forfeits that. No currency or numeric price field. |
| Size / colour choices | Client convention only | Text in `description`; or one item per variety under a group, if the group exists at list creation (Gap 2). |
| Typed, queryable price / URL / options | Needs a protocol change | An item-level `meta` bag or first-class columns: schema, table column, `setItemFields` field set, insert path. |
| Varieties as child items under an item | Needs a protocol change | No item children in the model (`markdown.ts:285-288`); ADR 0019 defers it. |
| Adding a sub-group to a wishlist later | Needs a protocol change | New `createListGroup` mutator (`sql.ts:1779-1781`). |
| Several givers counting toward one item | Client convention only | One claim row per giver on the Claims entity, or CAS-retry on a shared counter (`setItemQuantity.ts:39-48`). No atomic increment, no attribution. |
| Claim → wishlist item link, claimer identity | Client convention only | No `item_ref` / `claimed_by` fields; pack into existing strings. Server-attested claimer would need a protocol change. |

A convention packed into `description` is parsed by the wishlist client alone. Any structure (e.g. `url:` / `price:` lines) should degrade to readable text, because other clients will show or ignore it raw.

## Gaps found

1. **`createListItem` drops `description` on the server.** `insertListItem` inserts `id, name, parent_element_ref, references_entity_id, time_created, time_updated, type, value, version` and no `description` (`sql.ts:1747-1769`); the column defaults to `""` (`sql.ts:574`). The optimistic client write keeps the description (`createListItem.ts:78`), so it would appear and then vanish on the next pull (inferred; not reproduced). The same insert is used for items seeded through `initList` and `mintFromBlank` (`initList.ts:175-177`, `mintFromBlank.ts:137`), so a wishlist imported with descriptions in one `initList` would lose them. Group insert does write description (`sql.ts:1783-1805`). `packages/server-cf/test/createListItem.test.ts` never mentions `description`. Workaround: follow `createListItem` with `setItemFields({ description })`, which does write it (`sql.ts:1497-1500`). Looks like a bug rather than a decision. Not a blocker; worth its own issue.
2. **No way to add a group to an existing list** (above). Blocks only a design that lets owners add sections or variety-groups year-round. A flat wishlist is unaffected.
3. **ADR 0027's claim-row fields do not exist** (above). The Claims model works with conventions, but the ADR reads as if `item_ref` and `claimed_by` were fields.

None of the three prevents building a v1 client. Each narrows the design or needs a small protocol addition first.

## Not checked

- Runtime behaviour: every finding is from reading source; Gap 1 in particular should be reproduced before filing.
- Push body or row size limits for long descriptions.
- Whether `checker` is intended to be narrower than `editor`: it is in `EDIT_ROLES` for mutators (`_shared.ts:19-25`) but absent from the resolver's `EDITABLE_ROLES` (`packages/server-cf/src/auth/resolver.ts:213-217`).
