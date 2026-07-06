# ADR 0026: Entity-DO internal decomposition — no `DjibbWorkspace` subclass, two internal modules

- **Status:** Accepted
- **Date:** 2026-07-06
- **Layer:** server-cf

## Context

`list/durable_object.ts` is 3,318 LOC covering List/Template mutations, push/pull, the websocket hub, the workspace cascade dispatcher (ADR 0008), `is_personal`/Island bookkeeping, invitation preflight+commit (ADR 0009), the reconcile alarm (ADR 0007), snapshot emission, and email sending. CONTEXT.md's Workspace section promised a `DjibbWorkspace extends DjibbList` subclass ("when it lands" — `list/pull.ts:24`), and an architecture review flagged the file as the largest code/doc divergence.

Two facts resolved the question:

1. **Addressing.** There is one DO binding (`DJIBB_LIST`); every entity — including workspaces — is addressed by `idFromName(entityId)` in that single namespace. Cloudflare binds durable storage to (class binding, id) and instantiates exactly one class per namespace. A `DjibbWorkspace` bound as a second namespace strands every live workspace DO's storage (per-workspace export/import migration), forks routing in `fetch.ts`, and makes every cross-DO cascade call two-namespace bookkeeping. Per-id polymorphism within the existing namespace is impossible.
2. **ADR 0011 already rejected subclass-per-type** ("the divergence between the variants is too small to justify the inheritance machinery"). CONTEXT.md's subclass promise was drift, not doctrine.

## Decision

**One exported DO class, decomposed internally.** `DjibbList` remains the only DO class and the only namespace. Two internal modules are carved out — the two seams where complexity actually concentrates:

- **`workspace` module** — cascade dispatcher, `is_personal` invariants, Island coords. The DO delegates gated on the stored `type` discriminator.
- **`invitations` module (DO-side)** — preflight + commit orchestration. Its D1-index half moves into `derived-index/d1.ts` per ADR 0025; both halves are carved in the same PR series so `list/invitations.ts` (883 LOC) is visited once, not twice.

The websocket hub, email sender, and reconcile alarm **stay in place** — they are stable, and extracting a module nothing needs to vary or test separately is a hypothetical seam. This pass makes the DO navigable (~2,000 LOC), not small.

**Explicit dependencies, `sql.ts`-idiom free functions.** Modules receive narrow explicit arguments (`sql`, the `DJIBB_LIST` binding, `setAlarm`, the derived-index d1 module, the email sender's interface) — never `this` or a fat `{ctx, env}`. Passing raw CF types is fine (CF-native, consistent with ADR 0025's no-port stance); passing an already-designed module where one exists is required. 4–5 parameters on a cascade function is the interface telling the truth.

**Direct tests for invariant-bearing orchestration only.** The existing external DO tests (full push through the workers pool) remain the stable contract net and should barely change — that is the refactor's regression signal. New direct tests target what is miserable to construct externally: cascade partial-failure/re-arm, already-hard-deleted children, restore racing a fresh personal workspace, invite preflight/commit semantics — exercised through the modules' interfaces against miniflare `sql` and stub bindings. A direct test that needs to reach past the module's interface means the interface is wrong.

## Consequences

- CONTEXT.md's Workspace section corrected (no subclass; internal module + `type` gate). `list/pull.ts:24`'s "when it lands" comment dies with the implementation.
- Sequencing: invitations carve rides ADR 0025's derived-index phase; workspace module is a standalone series that must precede any *new* workspace feature; neither blocks candidates 2/3/5 of the review backlog.
- If a genuinely workspace-only *runtime* need ever appears (separate limits, different alarm cadence), that — not code organization — is the trigger to revisit a second namespace, with the data migration costed honestly.
