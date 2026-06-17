# ADR 0012: List as Markdown and JSON content encodings

- **Status:** Accepted (design + spike landed)
- **Date:** 2026-06-08

## Context

A List is a DO-backed entity (ADR 0011): an entity row plus `ListGroup`s
and `ListItem`s arranged through `child_element_refs` / `parent_element_ref`.
Two recurring needs want a *textual* projection of that structure:

1. **Portability / interchange.** "Copy this List as Markdown," `curl
   .../l/<id>.md`, hand a List to an agent, paste a NASA checklist *in*.
   Markdown is the lingua franca for all of these — humans and agents both
   author it natively, and the harness already renders GFM task lists.
2. **Seeding example content** (the companion effort: a homepage gallery of
   example Lists, some agent-contributed — see ADR 0013 / the
   `contribute-a-list` skill). The contribution format wants to be Markdown
   so Git is the review-and-curation layer, and the *importer* wants to be
   the same decoder as (1) rather than a parallel path. "djibb uses itself."

The schema is *more* expressive than Markdown in places (identity, auth,
`references_entity_id`, interleaved ungrouped items), so a single encoding
can't be both faithful and friendly. That tension is the decision.

## Decision

### A. Two encodings at two fidelity levels

| | JSON | Markdown |
|---|---|---|
| Fidelity | **lossless** | **lossy (content-only)** |
| Carries | `id`, `version`, timestamps, `authorization_rules`, `references_entity_id`, `slot`, `meta`, the full `child_element_refs` DAG | structure, names, descriptions, check-state, quantities |
| Round-trips | the **entity** | the **content** |
| Is | the DO state, filtered | a projection |

JSON is the canonical wire form; Markdown is the human/agent surface. They
are not competitors — Markdown is explicitly a lossy *view*, and anything
identity- or auth-bearing is JSON-only in v1 (`references_entity_id`,
`meta`, `authorization_rules`, all timestamps).

### B. The Markdown grammar

```markdown
---
djibb: template          # omit for a List (the default)
slug: pre-flight         # optional, lossless extra
forked_from: t/xxxxx     # optional lineage breadcrumb
---

# List or Template name

Optional description paragraph.

## Group name
Optional group description.
- [ ] A boolean item
- [x] A done boolean item
- [ ] Salt — 0/2 tsp         # fresh count: value 0, target 2
- [ ] Fuel — 3/10 gal        # partial count: value 3, target 10
- [x] Olive oil — 2/2 tbsp   # complete count (value === target)
  An indented continuation line is the item's description.
```

| djibb | Markdown |
|---|---|
| entity `name` | `# Heading` |
| entity / group / item `description` | paragraph under the heading; for items, an indented continuation line |
| `ListGroup` | `## Subheading` |
| `ListItem`, `unit: 'boolean'` | `- [ ]` / `- [x]`, no tail |
| `ListItem` count | `- [ ] name — <value>/<target> <unit>` |

**Frontmatter is emitted only when it carries something** — a Template
type, a slug, or a lineage pointer. A plain List with none of these is just
headings and bullets. This keeps the canonical form minimal and means a
pasted checklist (no frontmatter) is already valid input.

### C. Quantity spelling — the load-bearing convention

Completion is universal (`CONTEXT.md`): an item is done when
`value === target_value`, checkbox or count alike. So **the checkbox always
reflects completion**, and the tail (if any) carries the count:

- `boolean` unit → **no tail**; the checkbox *is* the value.
- any count → `— M/N unit` (value `M`, target `N`). A fresh count is just
  `— 0/N unit`; there is **no bare `N unit` shorthand**.

The slash is mandatory: a count is *always* `M/N unit`, full stop. This
makes the grammar perfectly regular — **a slash means count, and nothing
else does**. The aesthetic cost (a fresh count reads `0/2 tsp` rather than
`2 tsp`) is arguably a gain: `0/2 tsp` signals "count, currently empty" at a
glance, where `2 tsp` reads like a static label.

On the way back in, parsing is **grammar-driven, not separator-driven**: the
tail after the last ` — ` is read as a quantity only if it actually matches
`M/N unit` (the slash *and* a unit word are both required). This is what
lets an em dash live inside an item *name* — see Limitation 1.

### D. Where the code lives

A dependency-free, pure module (`workers/src/list/markdown.ts`): no DO, no
Zod, no nanoid — just `encodeMarkdown` / `parseMarkdown` over a content
model, plus `listToModel` / `listToMarkdown` adapters that project a real DO
bundle down (resolving order from `child_element_refs`). This matches the
pure-predicate convention in `docs/testing.md` and makes the round-trip
property testable in total isolation (`test/markdown.test.ts`).

The **inverse direction is intentionally split**: `parseMarkdown` yields the
content model; *wiring it back into a DO* (minting IDs, attaching auth,
running `initList` + element mutators) is the worker route / import path's
job, not this module's. The decoder mints no identity.

### E. The route (follow-up, not in the spike)

`/l/<id>.md` and `/l/<id>.json` over the existing authorized read path, with
the `.ext` suffix winning over an `Accept:` header when both are present
(curl, "copy link as markdown", and agents all reach for the suffix). The
route is a thin content-negotiation shim; the encoder is the substance.

### F. Subgroups and prose attachment (amendment, 2026-06-17)

Dogfooding a wild checklist — the WHO Surgical Safety list
(`seed/contributed/WHO-surgical-safety.md`, pulled from the WHO PDF) — broke
two assumptions the original spike made about how people actually write
checklists. Both are now fixed in the parser; the changes are additive and
keep the round-trip property.

**Fix 0 — prose attaches forward, to its container, not backward to the
previous item.** The original parser had one catch-all bucket that glued any
unrecognized line onto the *most recent item*. But a heading or a label
introduces what *follows* it. The rule is now: an **indented** continuation
line is the current item's description (unchanged, §B); any other loose prose
describes the innermost open **container** — section, else group, else list —
never the preceding item.

**Subgroups (C, building toward B).** The model gains a `MarkdownSection`: a
named bucket of items *within* a group. Two author surfaces parse into it —
a `###`..`######` heading and an **all-bold line** (`**To Surgeon:**`, the
WHO role labels). Canonical output spells both as `###` (bold is lenient
input, exactly as plain `-` is lenient for `- [ ]`). This is **option C**: in
the content model a section nests under a group, but the **DO mapping
flattens** section items into the group — the label is a *divider, not a
parent*. That flatten point (`djibb.ts`, the promote/mint path) is the seam
where **option B** (mint a real nested group per section) will later plug in.
Conditional subtrees (ADR 0019) build on B, not on C.

Accepted limitations, in the same spirit as 1–3 above:

4. **`###` and bold collapse to one section level.** The WHO list nests an
   `###` over bold sub-labels; both become sibling sections, so an outer `###`
   with only sub-sections under it round-trips as an *empty* section. B
   restores the nesting.
5. **A section is greedy, and a list-level footer has no home.** Once a
   section opens, following top-level items join it (so the WHO "Is essential
   imaging displayed?" item folds into the last role section — the §2 "`##` is
   terminal" wart, one level down). Trailing list-level prose (the WHO
   disclaimer + copyright) folds into the last open container's description,
   which the encoder renders *above* that container's items. Round-trip is
   still a fixpoint; the first-parse placement is just lossy.

### G. Nested groups (option B) — decided, not yet built (2026-06-17)

§F shipped option C (flat sections, flattened into the group at the DO layer).
Option B is the agreed next step: groups nest. These rules are locked so the
build doesn't relitigate them; conditional subtrees (ADR 0019) build on this.

- **One primitive.** `MarkdownSection` collapses into a **nestable
  `MarkdownGroup`** (`children: (MarkdownItem | MarkdownGroup)[]`). There is no
  separate "section" type — a subgroup is just a group with a group parent.
  This is also the substrate ADR 0019 will extend.
- **Depth comes from syntax.** `#` = list title, `##` = group depth 0, `###` =
  depth 1, … `######` = depth 4. Subgroups **canonicalize by depth**: the
  canonical spelling of a depth-_n_ group is its heading level, full stop.
- **Bold labels are subgroups, not headings.** An all-bold line
  (`**To Surgeon:**`) opens a subgroup of the **most recent _true-heading_
  group** — never of a previous bold group. So consecutive bold labels are
  *siblings* under their heading, not a stack; a real heading resets the
  anchor. A bold directly under `##` (no `###`) lands at depth 1. On encode it
  takes the heading level for its depth (`**To Surgeon:**` under `###` →
  `#### To Surgeon`). Bold-ness is **not** preserved — Markdown stays a lossy
  view, one spelling per shape (exactly as `-` → `- [ ]`).
- **Max depth 4 (`######`), enforced as a model invariant.** The ceiling is
  where heading syntax runs out, not an arbitrary pick. It is enforced on the
  **write side** (create/move mutators reject a group deeper than depth 4),
  not only in the parser — otherwise JSON could hold a depth Markdown can't
  spell, reintroducing the very asymmetry this ADR exists to avoid.
- **Overflow clamps.** Lenient input below the floor (`#######`, or a bold
  under `######`) **clamps** to the deepest valid level rather than erroring —
  characterized by a test, like the limitations below.

Building B **dissolves limitation 4** (the `###`/bold collapse): a bold now
nests under its heading instead of becoming a sibling, so an `###` over bold
sub-labels keeps its shape. **Limitation 5 persists** — it is Limitation 2
(headings are terminal) generalized to every depth: once a subgroup heading
opens, a following top-level bullet still joins the deepest open group (the WHO
"Is essential imaging displayed?" item folds into the last role subgroup), and
trailing list-level prose still has no home above the group it lands in. B
makes the tree deeper; it does not give a bullet a way to climb back up.

**Status note:** option B landed in the parser/encoder/projection; the §F
option-C `MarkdownSection` type and its DO-flattening are gone. The DO *mint*
path (`djibb.ts`) still flattens for now — `initList` parents every group to
the list — until the mutator slice lets a group parent a group.

## The round-trip property

The headline guarantee, locked by `test/markdown.test.ts`:

```
parse(encode(model))         deep-equals  model          (canonical models)
encode(parse(encode(model))) ===          encode(model)  (canonical fixpoint)
```

The encoder emits exactly one canonical spelling; the parser is strictly
*more lenient* (accepts plain `-` bullets, missing frontmatter, loose blank
lines). That asymmetry is deliberate: wild input flows in, our own output
stays stable.

Round-trip property is scoped to entity frontmatter (`slug`/`forked_from`); any gallery fields are Git-layer-only.

## Limitations (accepted, characterized by tests)

These surfaced from dogfooding the spike and are encoded as
characterization tests so they're visible, not silent:

1. **An em dash in an item name** collides with the ` — ` quantity
   separator. Resolved by grammar-driven parsing: a boolean item emits no
   tail, so `Chicken — skip the brine` has no quantity grammar after the
   dash and round-trips intact. Requiring the slash (§C) shrinks the
   residual edge from "any number + unit" (`Rest — 5 min`, common) to "a
   literal fraction-slash + unit word in a name" (`Sprint — 3/4 mile` meant
   as prose) — which is essentially never written. `Rest — 5 min` now has no
   slash, so it stays prose and the item stays boolean. Documented for the
   vanishing case that remains.

2. **Ungrouped items after a group are not representable.** A `##` heading
   is terminal in Markdown: once a group opens, every following bullet
   belongs to it. The model permits ungrouped items interleaved *after* a
   group (via `child_element_refs` order); Markdown can only express
   ungrouped items that **precede the first group**. The encoder does **not**
   silently reorder (that would be worse than the limitation); such items
   fold into the preceding group on round-trip. In practice Lists are
   almost always all-grouped or all-ungrouped, so this rarely bites.

3. **JSON-only fields are dropped** in Markdown by definition:
   `references_entity_id`, `meta`, `authorization_rules`, `slot`,
   timestamps, `version`, and `id`. A Markdown import is *new* content; use
   JSON when identity must survive.

## Alternatives considered

- **One lossless Markdown via HTML comments / embedded JSON.** Rejected:
  it makes the human surface ugly to serve the machine surface JSON already
  serves. Keep Markdown honest about being a view.
- **Separator-driven quantity parse** (split on the first ` — `). Rejected
  in the spike — it ate em dashes in names. Grammar-driven is barely more
  code and far more robust.
- **Reorder ungrouped items to the front on encode** to dodge Limitation 2.
  Rejected: silent reordering violates the ordering contract and surprises
  the author. A documented, tested limitation is the honest choice.

## Consequences

- The example-List seeding effort (ADR 0013) gets its importer for free —
  same decoder, Git as the curation layer.
- A future `.md`/`.json` route is a thin shim over an already-tested core.
- The quantity grammar (§C) is now a published contract; changing it is a
  breaking change to every exported/contributed `.md`.
