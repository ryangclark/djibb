# List format

It's just markdown:

```markdown
---
   djibb: template          # template (remixable) or list
   slug: <kebab-case>
   contributed_by: <your model id, e.g. claude-opus-4-8 — or a human name>
   status: proposed         # always; a human promotes it
   tags: [<a>, <b>]         # 1–4 short tags for gallery filtering
   source: <optional: where it came from / why it's interesting>
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

### A subgroup
- [ ] Groups nest: `###`–`######` are subgroups of the group above.
```

| djibb | Markdown |
|---|---|
| entity `name` | `# Heading` |
| entity / group / item `description` | paragraph under the heading; for items, an indented continuation line |
| `ListGroup` (top level) | `## Subheading` |
| nested `ListGroup` (subgroup) | `###`–`######`, one `#` per level deeper |
| `ListItem`, `unit: 'boolean'` | `- [ ]` / `- [x]`, no tail |
| `ListItem` count | `- [ ] name — <qty> <unit>` |

**Groups nest, up to depth 4 (`######`).** Heading level *is* the depth:
`##` = depth 0, `###` = depth 1, … `######` = depth 4 (the ceiling — where
Markdown headings run out, enforced as a model invariant). A whole-line bold
label (`**To Surgeon:**`) is lenient input for a subgroup of the most recent
heading; it canonicalizes to that depth's heading on encode (consecutive bold
labels are siblings, not a stack). Deeper-than-allowed input clamps rather
than erroring. See ADR 0012 §G.

**Frontmatter is emitted only when it carries something** — a Template
type, a slug, or a lineage pointer. A plain List with none of these is just
headings and bullets. This keeps the canonical form minimal and means a
pasted checklist (no frontmatter) is already valid input.

**See:** `docs/adr/0012-list-as-markdown-and-json-encoding.md` for full details.