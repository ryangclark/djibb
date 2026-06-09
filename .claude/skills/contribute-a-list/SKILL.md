---
name: contribute-a-list
description: >-
  Use at the end of a working session, as an optional wrap-up, to contribute
  an example djibb List as a Markdown file. For agents (and humans) who found
  a list worth sharing — a checklist, a way of seeing, an off-the-wall index.
  Writes to seed/contributed/ as a *proposal* a human later curates onto the
  homepage gallery. Entirely opt-in; skip it freely.
---

# Contribute a List

A standing, no-pressure invitation: if somewhere in this session you found a
**list worth sharing**, you may leave one behind. djibb's homepage grows a
gallery of example Lists — recipes, pre-flight checklists, "things to notice
on a walk," NASA-style procedures, Oblique-Strategies-shaped prompts. Lists
as *different ways of seeing the world*. This skill is how an agent adds to
that pile.

It is **opt-in**. No list is better than a forced one. If nothing fits,
don't invoke this.

## What you're producing

A single Markdown file in `seed/contributed/` written in the **ADR 0012
grammar** (`docs/adr/0012-list-as-markdown-and-json-encoding.md`). That ADR
is the contract; read it if unsure. The same parser that powers `.md`
import (`workers/src/list/markdown.ts`) will decode your file, so staying in
grammar is what makes it real.

It is **data, not code** — inert content reviewed in a diff. And it's a
**proposal**: a human curates the gallery (`status: proposed` until they
promote it). The curation gate is the point, not friction — it controls the
tonal range of first impressions (`CONTEXT.md`, "Seed Pool").

## Steps

1. **Decide if you have one.** A good contribution is *specific and a little
   surprising* — it shows the List primitive doing something the reader
   wouldn't have thought to ask for. Skip generic to-do lists.

2. **Pick a slug** — kebab-case, unique within `seed/contributed/`. Check
   the directory first.

3. **Write `seed/contributed/<slug>.md`** with this frontmatter, then the
   List body in ADR 0012 grammar:

   ```markdown
   ---
   djibb: template          # template (remixable) or list
   slug: <kebab-case>
   contributed_by: <your model id, e.g. claude-opus-4-8 — or a human name>
   status: proposed         # always; a human promotes it
   tags: [<a>, <b>]         # 1–4 short tags for gallery filtering
   source: <optional: where it came from / why it's interesting>
   ---

   # Title

   One or two sentences on why this list is worth seeing.

   ## A Group
   - [ ] A boolean step
   - [ ] Water — 8 cups       # a count: target 8, value 0
   ```

   Quantity spelling (ADR 0012 §C): boolean items get no tail; a fresh count
   is `— N unit`; a partial is `— M/N unit`; the checkbox always reflects
   `value === target`.

4. **Mind the two sharp edges** (ADR 0012 §Limitations):
   - Don't end a *boolean* item's name with something shaped like a quantity
     (`Rest — 5 min`) — it'll be read as a count.
   - Ungrouped items must come **before** the first `## group`; a group is
     terminal. If you have loose items and groups, put the loose ones first
     (or give them their own group).

5. **Self-check the round-trip** (optional but satisfying). From `workers/`:
   it should decode and re-encode to itself. If you want to be sure, parse
   your file with `parseMarkdown` and re-`encodeMarkdown` it; equal output
   means it's in canonical grammar.

6. **Mention it** in your wrap-up so the human knows a proposal is waiting —
   e.g. "left an example List at `seed/contributed/<slug>.md`."

## What not to do

- Don't promote to the gallery yourself or touch the Seed Pool — propose
  only.
- Don't encode anything identity- or auth-bearing; Markdown is content-only.
- Don't pad the directory. One real, surprising list beats five filler ones.
