# Architecture Decision Records

Append-only, chronologically numbered. Numbers are immutable identities — never renumber or relocate. Each ADR carries a `Layer:` field naming who needs to read it; ADRs that genuinely span layers list both (comma-separated).

## Layers

- **protocol** — the djibb protocol: client↔authority behavior, entity model, encodings, auth semantics. The contract any client (including weird ones) must honor. (`packages/protocol`)
- **server-cf** — how the *current* authoritative server implements the protocol on Cloudflare DO + D1. (`packages/server-cf`)
- **client/`<name>`** — product/UX decisions for *one specific* client. Each client is independently weird, so the layer is namespaced per product: `client/djibb.com`, `client/cli`, `client/agent`, … A weird new client opens a new namespace; no existing ADR moves. (`apps/djibb-com`, `packages/client`)
- **meta** — cross-cutting structure of the whole project.

To learn the contract you build against, read the **protocol** row and ignore the rest.

## Index

### protocol
- [0006](0006-clientid-tagged-websockets-for-outcome-routing.md) — clientID-tagged websockets for per-mutation outcome routing
- [0011](0011-djibblist-as-universal-entity-substrate.md) — `DjibbList` as universal entity substrate; unified role enum
- [0012](0012-list-as-markdown-and-json-encoding.md) — List as Markdown and JSON encodings
- [0019](0019-conditional-subtrees.md) — Conditional subtrees (stub)
- [0020](0020-push-auth-reconciliation.md) — Push-time authorization reconciliation (ack vs. throw)
- [0021](0021-role-gated-reads-and-read-write-role-lattice.md) — Role-gated reads (view-floor) and the read/write lattice
- [0023](0023-recoverability-over-step-up-for-destructive-actions.md) — Recoverability over step-up for destructive actions *(cross-client policy)*

### server-cf
- [0001](0001-entity-metadata-in-d1-with-do-mirror.md) — Entity metadata in D1, elements in DO *(superseded by 0003)*
- [0003](0003-do-as-authority-with-d1-derived-index.md) — DO as authority; D1 as derived read index
- [0007](0007-d1-reconciliation-sweeper.md) — D1 reconciliation sweeper via DO alarms
- [0008](0008-cascade-delete-via-workspace-alarm.md) — Cascade delete via Workspace-DO alarm dispatcher
- [0013](0013-account-level-cvr-sync-thin-account-do.md) — Account-level synced view *(deferred)*
- [0015](0015-effect-as-backend-spine.md) — Effect as the backend spine

### client/djibb.com
- [0002](0002-djibb-com-as-island-homepage.md) — djibb.com homepage: Minted List + Island map
- [0004](0004-list-view-keyboard-and-cursor-model.md) — List view keyboard and cursor model

### client/agent
- [0018](0018-sidecar-agent-runtime.md) — Sidecar Agent runtime: concierge DOs as port clients

### meta
- [0014](0014-protocol-client-backend-package-split.md) — Protocol / client / backend package split; the `EntityStore` port
- [0016](0016-licensing-and-repository-structure.md) — Licensing and repository structure (open-core monorepo)

### straddlers (span layers)
- [0005](0005-undo-and-inverse-mutators.md) — Undo via paired forward+inverse mutators — *protocol, client/djibb.com*
- [0009](0009-invitations-tokenless-do-resident.md) — Invitations: tokenless, DO-resident, pull-filtered — *protocol, server-cf*
- [0010](0010-authentication-magic-link-floor.md) — Authentication: magic-link floor, OAuth, passkey — *protocol, server-cf*
- [0017](0017-self-improvement-loop-and-carryover.md) — Self-improvement loop; carryover durability axis — *protocol, client/agent*
- [0022](0022-client-authentication-and-credentials.md) — Client authentication and credentials — *protocol, client/cli*
