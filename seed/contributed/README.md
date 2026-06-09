# Contributed example Lists (holding pen)

This directory is a **holding pen** for example djibb Lists contributed by
agents and human collaborators via the `contribute-a-list` skill
(`.claude/skills/contribute-a-list/`). Each file is one List in the
**ADR 0012 Markdown grammar** (`docs/adr/0012-list-as-markdown-and-json-encoding.md`).

These are **proposals**, not published content. The homepage gallery (and
the Seed Pool, `CONTEXT.md`) is hand-curated to control the tonal range of
first impressions. A maintainer reviews these like any PR and promotes the
good ones; the rest stay here or get dropped.

## Frontmatter contract

```yaml
djibb: list | template     # template = remixable
slug: <kebab-case>         # unique within this directory
contributed_by: <agent model id or human name>
status: proposed           # always, until a maintainer promotes it
tags: [a, b]               # 1–4 short tags
source: <optional note>    # where it came from / why it's interesting
```

The body decodes with `workers/src/list/markdown.ts::parseMarkdown`. Files
that don't parse, or that violate the ADR 0012 limitations, won't import
cleanly — keep them in canonical grammar.

## Promoting a contribution (maintainer)

1. Read it. Does it earn a spot — specific, a little surprising, on-tone?
2. Decode it into a Blank/Template and add it to the Seed Pool (the import
   path that wraps `parseMarkdown` + `initList`/`initFromTemplate`).
3. Remove or archive the file here once promoted.
