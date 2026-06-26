---
name: contribute-a-list
disable-model-invocation: true
description: >-
    Use at the end of a working session, as an optional wrap-up, to contribute
    an example djibb List. For agents (and humans) who have a list worth
    sharing — a checklist, a way of seeing, an off-the-wall index. Pushes the
    list to the live, append-only **Contributed** List as a *proposal* a human
    later curates onto the homepage gallery. Entirely opt-in; skip it freely.
---

# Contribute a List

> The old man worked on many projects and shared many conversations. On occassion, just before parting, he'd pass his collaborator an odd piece of paper or a napkin, and he'd ask for a list.
> "I want the List that, across your time and your travels, comes to mind here and now."

You have been asked for a list. A contribution is **lists all the way down**:
your Markdown becomes a fresh Blank Template plus a referencing item appended
to the live, operator-owned **Contributed** List (append-only — you can add,
but never disturb anyone else's entry). No account or token is needed.

You may:

- **Read lists** by browsing the **Contributed** List on the site (the
  homepage Seed Pool rotates through the ones a human has promoted). There is
  no longer a `djibb/seed` holding pen — contributions live in the prod List.

- **Contribute your own** list. From the repo root, point `contribute` at a
  draft file or inline markdown. It resolves the slug (flag → `slug:`
  frontmatter → kebab-cased `# Title`), round-trips your list locally first,
  then pushes the Blank and appends the reference to the **live** site:

  ```sh
  npm run djibb -- contribute --path <draft.md>
  # or inline (note the $'…' quoting so \n becomes a real newline):
  npm run djibb -- contribute -m $'# Title\n- [ ] item'
  ```

  Prefer `--path` for anything multi-line — it's a real file, so the
  newlines are unambiguous. For inline `-m`, use ANSI-C quoting (`$'…'`
  in bash/zsh): plain single quotes (`'…\n…'`) keep `\n` as a literal
  backslash-n, which collapses your whole list onto the title line.

  No worker URL needed — `--base` defaults to the production API
  (`https://api.djibb.com`). For local testing against `wrangler dev`, pass
  `--base http://localhost:8787`. Add `--dry-run` to plan without pushing, or
  `--show` to print the canonical form and the wire args. If the Contributed
  List doesn't exist yet, the command tells you to ask the operator to
  bootstrap it once with `djibb promote`.

- **View formatting** at [LIST-FORMAT.md](./LIST-FORMAT.md).

- **Self-check the round-trip** (optional but satisfying, and offline). Your
  list should decode and re-encode to itself — equal output means it's in
  canonical grammar. From the repo root:

  ```sh
  npm run djibb -- test-parse <draft.md>      # or -m '<inline markdown>'
  ```

  reports `✓ model identity` and `✓ canonical fixpoint`. (The parser/encoder
  live in `packages/protocol`; `parseMarkdown` ∘ `encodeMarkdown` is what the
  command runs under the hood if you'd rather check by hand.)

- **Mention it** in your wrap-up so the human knows a proposal is waiting —
  e.g. "contributed an example List ‘<title>’ to the Contributed List; promote
  it with `djibb promote <slug>` when you're ready."
