# djibb context map

djibb is a **multi-context** project: one protocol spine, one backend, many (deliberately weird) clients. This file routes you to the right `CONTEXT.md` for whatever you're touching. The shared glossary in [`CONTEXT.md`](./CONTEXT.md) holds the canonical domain language (List, Template, Quantity, Workspace, …) that every context inherits.

**The protocol is the spine.** It governs every backend⇄client interaction, so a protocol change ripples to *all* clients and belongs with system-wide decisions. A client's own context covers what's unique to it — its auth floor, its interaction model, its experience constraints — and should not be hoisted into the shared layer.

## Shared

| Context  | Where                     | What it covers |
| -------- | ------------------------- | -------------- |
| Glossary | [`CONTEXT.md`](./CONTEXT.md) | Canonical domain terms shared by everyone. |
| Protocol | `packages/protocol/` | The djibb protocol — the contract for backend⇄client interaction. Changes here impact every client; treat as system-wide. |

System-wide and protocol-level decisions live in [`docs/adr/`](./docs/adr/).

## Backend

| Context | Where | What it covers |
| ------- | ----- | -------------- |
| Cloudflare backend | [`packages/server-cf/`](./packages/server-cf/CONTEXT.md) | The one backend: Durable Objects, D1, reconciliation, auth enforcement. Also hosts the `djibb` CLI in its bin. |

## Clients

Each client may set a different auth floor and a different interaction model — that divergence is the point, not an accident.

| Context | Where | Status | What makes it weird |
| ------- | ----- | ------ | ------------------- |
| Shared client substrate | `packages/client/` | active | Common client primitives (`@djibb/client`) reused across clients. |
| djibb.com webapp | `apps/djibb-com/` | active | Restricts verbatim template copy — forces re-typing/dictation so retention is a from-scratch act. |
| djibb CLI | `packages/server-cf/` (bin) | active | Operator/terminal surface; product recipes like `promote`/`contribute`. |
| Email | _planned_ | planned | Inherently different auth and interaction model from a webapp. |
| Secret Santa webapp | _planned_ | planned | Standalone experience over the same protocol. |
| Voice-only client | _planned_ | planned | No text input; speech-to-text / voice mode / accessibility-first. |

## Per-context CONTEXT.md and ADRs

Per-context `CONTEXT.md` files (and optional context-scoped `docs/adr/`) are created **lazily** by `/domain-modeling` when real terms or decisions get resolved — they are not stubbed upfront. Read one if it exists; proceed silently if it doesn't. The shared `CONTEXT.md` and root `docs/adr/` always exist and should always be consulted.

See [`docs/agents/domain.md`](./docs/agents/domain.md) for how the engineering skills consume all of this.
