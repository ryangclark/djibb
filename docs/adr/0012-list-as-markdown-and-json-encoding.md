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
- [ ] Salt — 2 tsp           # fresh count: target 2, value 0
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
| `ListItem` count | `- [ ] name — <qty> <unit>` |

**Frontmatter is emitted only when it carries something** — a Template
type, a slug, or a lineage pointer. A plain List with none of these is just
headings and bullets. This keeps the canonical form minimal and means a
pasted checklist (no frontmatter) is already valid input.

### C. Quantity spelling — the load-bearing convention

Completion is universal (`CONTEXT.md`): an item is done when
`value === target_value`, checkbox or count alike. So **the checkbox always
reflects completion**, and the tail (if any) carries the count:

- `boolean` unit → **no tail**; the checkbox *is* the value.
- fresh count (`value === 0`) → `— N unit` (target `N`, value `0`).
- any other count → `— M/N unit` (value `M`, target `N`).

On the way back in, parsing is **grammar-driven, not separator-driven**: the
tail after the last ` — ` is read as a quantity only if it actually matches
`M/N unit` / `N unit` (a unit word is required). This is what lets an em
dash live inside an item *name* — see Limitation 1.

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

## Limitations (accepted, characterized by tests)

These surfaced from dogfooding the spike and are encoded as
characterization tests so they're visible, not silent:

1. **An em dash in an item name** collides with the ` — ` quantity
   separator. Resolved by grammar-driven parsing: a boolean item emits no
   tail, so `Chicken — skip the brine` has no quantity grammar after the
   dash and round-trips intact. The residual edge — a boolean item whose
   name *ends* in something shaped like a quantity (`Rest — 5 min`) — will
   be read as a count. Rare; documented.

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
