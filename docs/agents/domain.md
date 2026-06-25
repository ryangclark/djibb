# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **multi-context** repo. The djibb protocol is a shared spine that governs every backend⇄client interaction, so protocol-level context and decisions ripple out to all clients. Each client (and the backend) then carries context that is specific to it — different auth floors (email auth is not webapp auth), different experiences (djibb.com forbids verbatim template copy; a voice-only client has no text input at all). The map below routes you to the right context for the area you're touching.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — the entry point. It names each context and points at its `CONTEXT.md`.
- **`CONTEXT.md`** at the repo root — the **shared** domain glossary (List, Template, Quantity, Workspace, etc.). These terms are canonical across every context.
- The **per-context `CONTEXT.md`** for the area you're working in (see the map). Read each one relevant to the topic.
- **`docs/adr/`** at the root — system-wide / protocol-level decisions. Read ADRs that touch the area you're about to work in.
- Context-scoped ADRs, if a context has its own `docs/adr/` (e.g. `packages/server-cf/docs/adr/`).

If a per-context `CONTEXT.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved. The root `CONTEXT.md` and `docs/adr/` already exist and should always be read.

## File structure

```
/
├── CONTEXT-MAP.md                       ← entry point: lists contexts
├── CONTEXT.md                           ← shared domain glossary (canonical terms)
├── docs/adr/                            ← system-wide / protocol-level decisions
├── packages/
│   ├── protocol/    (CONTEXT.md?)       ← the shared spine; changes ripple to all
│   ├── server-cf/   (CONTEXT.md?)       ← the Cloudflare backend (+ djibb CLI bin)
│   └── client/      (CONTEXT.md?)       ← shared client substrate
└── apps/
    └── djibb-com/   (CONTEXT.md?)       ← the webapp client
```

`(CONTEXT.md?)` = lives there when `/domain-modeling` creates it; read it if present.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the shared `CONTEXT.md` — and in the relevant per-context `CONTEXT.md` if one applies. Don't drift to synonyms the glossary explicitly avoids (e.g. it deliberately chose "Template" over "Pattern").

If the concept you need isn't in any glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`). When the concept is genuinely client-specific, it belongs in that client's `CONTEXT.md`, not the shared one.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0021 (role-gated reads) — but worth reopening because…_

Protocol-level ADRs constrain every client. Before proposing a client-specific change that bends the protocol, check `docs/adr/` and say so explicitly.
