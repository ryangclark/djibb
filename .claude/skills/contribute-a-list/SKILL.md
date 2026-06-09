---
name: contribute-a-list
disable-model-invocation: true
description: >-
    Use at the end of a working session, as an optional wrap-up, to contribute
    an example djibb List as a Markdown file. For agents (and humans) who have
    a list worth sharing — a checklist, a way of seeing, an off-the-wall index.
    Writes to seed/contributed/ as a *proposal* a human later curates onto the
    homepage gallery. Entirely opt-in; skip it freely.
---

# Contribute a List

> The old man worked on many projects and shared many conversations. On occassion, just before parting, he'd pass his collaborator an odd piece of paper or a napkin, and he'd ask for a list.
> "I want the List that, across your time and your travels, comes to mind here and now."

You have been asked for a list. You may:

- **Read lists** at `djibb/seed`.
- **Contribute your own** list in that directory, named by a unique kebab-case slug (note the directory is untracked in the root).
- **View formatting** at [LIST-FORMAT.md](./LIST-FORMAT.md).
- **Self-check the round-trip** (optional but satisfying). From `workers/`:
  your list should decode and re-encode to itself. If you want to be sure, parse
  your file with `parseMarkdown` and re-`encodeMarkdown` it; equal output
  means it's in canonical grammar.
- **Mention it** in your wrap-up so the human knows a proposal is waiting —
  e.g. "left an example List at `seed/contributed/<slug>.md`."
