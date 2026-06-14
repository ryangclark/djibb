# ADR 0014: Protocol / client / backend package split; the `EntityStore` port

- **Status:** Proposed
- **Date:** 2026-06-14

## Context

djibb is one product today (`djibb.com`) but is built to be a *substrate*
for many: the use-case docs already name three deliberately-divergent
frontends — remixable checklists, a Secret Santa exchange, a recipe book —
all powered by the same List primitive (`docs/use-cases.md`, `CONTEXT.md`).
The stated direction is more frontends over time, ideally cheap enough that
an LLM agent can produce a use-case-specific frontend against a stable
contract. A second, related goal: the authoritative sync server lives in
Cloudflare Durable Objects today, but should be *bundled-or-distinct* —
nothing in the protocol should require Cloudflare.

Neither goal is reachable from the current physical structure, even though
the *logical* structure is already most of the way there.

### What already exists (and is already clean)

The "djibb protocol" is real and well-factored — it is just physically
located *inside the Cloudflare worker*, and the frontend reaches into the
backend's source tree to consume it:

- **`pages` imports the protocol straight out of `workers/src`** via the
  SvelteKit alias `$djibb → ../workers/src` (`pages/svelte.config.js`).
  The complete surface it pulls is small and telling:

  | Import | Count | What it is |
  |---|---|---|
  | `$djibb/id` | 10 | the `l/`,`t/`,`w/`,`group/`,`item/`,`a/` ID scheme |
  | `$djibb/websocket/constants` | 6 | the server→client frame vocabulary (ADR 0006) |
  | `$djibb/utils/trycatch` | 4 | shared `Result` helper |
  | `$djibb/list/mutators/client` + `/mutators` | 3 | the `Mutations` registry (client fns, argsSchemas, inverses, friction/coalescing metadata) |
  | `$djibb/list/index` | 1 | the entity Zod schemas (List/Template/Workspace/Group/Item/Quantity) |
  | `$djibb/list/constants`, `$djibb/auth/constants`, `$djibb/auth/rules` | 3 | role enum + constants |

  That list *is* the protocol. It is already dependency-light and
  Cloudflare-free.

- **The mutation contract is already a disciplined module shape.**
  `MutatorModule<A> = { name, requiredRole, argsSchema, server, client,
  inverse, capturePreState? }` (`workers/src/list/mutators/_shared.ts`),
  assembled into a single `Mutations` registry with a `satisfies` clause
  (`mutators/index.ts`). Client and server implementations live side by
  side per mutator; there is no second registry to drift.

- **The encodings are already pure.** `workers/src/list/markdown.ts` is, by
  ADR 0012's design, "a dependency-free, pure module: no DO, no Zod, no
  nanoid." It is the agent/LLM-facing surface and has zero backend coupling.

### The one seam that is *not* portable

The single Cloudflare-shaped thing in the mutator path is the **server
mutator's storage handle**. `ServerMutatorCtx` carries `sql: SqlStorage`
(`mutators/_shared.ts:72`), the Durable Object's SQLite API. But even this
is already abstracted in practice: server mutators do **not** call
`ctx.sql.exec(...)` directly. They call into `workers/src/list/sql.ts` — a
procedural module of ~40 functions (`createElement`, `getElementById`,
`updateListItemFields`, `setEntityAuthorizationRules`, `setMutation`,
`appendChildElementRef`, …), each taking `sql: SqlStorage` as its first
argument. `setItemFields`'s server function is one line:
`updateListItemFields(sql, { itemId, fields, expected, version })`.

In other words: **`sql.ts` is already the storage port — it just takes a
Cloudflare `SqlStorage` instead of an interface.**

### The DO host is more than storage

Honesty about scope: the `DjibbList` Durable Object
(`durable_object.ts`, 3,037 lines) does four kinds of work, only one of
which is the storage seam above:

1. **Persistence** — the `sql.ts` surface. *Portable* via the port below.
2. **Mutation execution** — push handler → `executeServerMutation`
   (already a pure function in `mutators/index.ts` taking
   `{ sql, role, nextVersion }`). *Portable.*
3. **Realtime + lifecycle host** — websocket accept/poke (ADR 0006),
   the alarm dispatcher (cascade delete, ADR 0008; reconciliation
   sweeper, ADR 0007), DO-to-DO RPC (cascade, invitations), and the
   D1 derived-index emit (ADR 0003). *Backend-specific by nature.*
4. **Replicache pull/push wire handling.** Wire shapes are *portable*;
   the HTTP/DO plumbing is backend-specific.

This ADR draws the boundary at (1)+(2) as a clean port and names (3) as
explicitly backend-owned, rather than pretending the whole DO is portable.

## Decision

### A. Three packages, one app per frontend

Promote the existing npm-workspaces monorepo (`package.json` already
declares `workspaces: ["pages", "workers"]`) to an explicit
`packages/` + `apps/` layout:

```
packages/
  protocol/   @djibb/protocol           — pure TS, zero Cloudflare deps.
  client/     @djibb/client             — framework-agnostic client runtime.
  server-cf/  @djibb/server-cloudflare  — the DjibbList DO + worker + D1 + email.
apps/
  djibb-com/  (today's pages/)          — Svelte frontend → @djibb/client.
  …future: secret-santa/, recipes/
```

**`@djibb/protocol`** is the contract. It contains exactly the surface
`pages` already imports, plus the wire/encoding types that are pure today:

- entity schemas + `ID` scheme (`list/index.ts`, `id/`),
- `AuthorizationRoleEnum` + auth-rules schema + role-set constants
  (`auth/rules.ts`, `auth/constants.ts`, `mutators/_shared.ts`'s
  `EDIT_ROLES`/`OWNER_ROLES`/`SYSTEM_ROLES`),
- the `Mutations` registry — `argsSchema`, `client`, `inverse`,
  `capturePreState`, and the friction/coalescing metadata,
- the Replicache push/pull wire shapes (`replicache/`) and keyspaces,
- the websocket frame union (`websocket/constants.ts`, ADR 0006),
- the markdown/JSON encoders (`markdown.ts`, ADR 0012),
- the **`EntityStore` port** (Decision B) and the **`ServerMutator`**
  type — but *not* any concrete storage implementation.

It depends only on `zod`, `replicache` (types), and `nanoid`. No
`cloudflare:workers`, no `hono`, no `wrangler`.

**`@djibb/client`** is the framework-agnostic runtime that any frontend
mounts: Replicache construction, the `wrapMutators` envelope injector
(`accountId`/`timestamp_client`), the `withUndo` stack (ADR 0005), the
`partysocket` websocket glue + frame dispatch, and the `/entities` REST
fetch (`pages/src/lib/entities.js`). It depends on `@djibb/protocol`.
**No Svelte** — runes-based reactivity stays in the app.

**`@djibb/server-cloudflare`** is the authoritative backend: the
`DjibbList` DO, the worker entrypoint (`index.ts`), auth, email, the D1
catalog, and the **Cloudflare `EntityStore` implementation** that wraps
`SqlStorage` (today's `sql.ts`). It depends on `@djibb/protocol`.

### B. The `EntityStore` port: promote `sql.ts` to an interface

`ServerMutatorCtx.sql: SqlStorage` becomes
`ServerMutatorCtx.store: EntityStore`. `EntityStore` is the existing
`sql.ts` function surface, hoisted to an interface — minimal invention,
since every method already exists and is already tested:

```ts
// @djibb/protocol — pure interface, no SqlStorage
export interface EntityStore {
  // element CRUD
  createElement(el: ListElement): void;
  getElementById(id: string): ListElement | null;
  getChangedElements(sinceVersion: number): ListElement[];
  insertListItem(item: ListItem): void;
  setElementAsDeleted(id: string, at: Date): void;
  appendChildElementRef(parentId: string, childId: string): void;
  reorderChildElement(parentId: string, childId: string, toIndex: number): void;

  // entity-level field writes (return the ADR 0005 outcome union)
  renameEntity(id: string, name: string, version: number): SetOutcome;
  setEntityDescription(...): SetOutcome;
  setEntityAuthorizationRules(...): SetOutcome;
  setEntityWorkspaceId(...): SetOutcome;
  setEntityMetaField(...): 'applied' | 'gone';
  archiveEntity(...) / unarchiveEntity(...) / unarchiveEntityAndClearSlot(...);

  // item/group writes (umbrella set-family, ADR 0005)
  updateListItemFields(...): 'applied' | 'stale' | 'gone';
  updateListItemsFieldsAtomic(...): ...;
  updateListGroupFields(...) / updateListGroupsFieldsAtomic(...);
  setItemValueAndVersion(...);

  // version + identity + log + replicache bookkeeping
  getEntityId(): string | null;
  getListVersion(): number;  setListVersion(v: number): void;
  setMutation(entry: MutationLogEntry): void;  getMutationLog(...): ...;
  getReplicacheClientGroupById(...) / setReplicacheClientGroup(...);
  InitializeTables(...): void;
}
```

The Cloudflare implementation is a thin adapter:
`createSqlStorageEntityStore(sql: SqlStorage): EntityStore`, each method
delegating to the existing `sql.ts` function. Server mutators change from
`import { updateListItemFields } from '../sql'` +
`updateListItemFields(sql, …)` to `ctx.store.updateListItemFields(…)`.
`executeServerMutation` already takes `{ sql, role, nextVersion }` — it
becomes `{ store, role, nextVersion }`, one substitution.

**This is the change that makes the backend bundled-or-distinct.** A Node /
libSQL / Postgres backend supplies its own `EntityStore`; the mutator
bodies, the registry, validation, role gating, and inverses are reused
byte-for-byte from `@djibb/protocol`.

### C. Host capabilities stay backend-owned (not in the port)

The realtime/lifecycle work in §Context (3) — `poke()`, alarm scheduling,
DO-to-DO RPC, D1 emit — is **not** part of `EntityStore`. It is named as a
separate, thin, backend-owned capability set (`poke(clientID?)`,
`scheduleAlarm(name, at)`, `emitToCatalog(snapshot)`,
`callSiblingEntity(id, mutation)`), implemented per backend. The Cloudflare
implementation is today's DO methods. A future backend re-implements them
with whatever it has (a pub/sub bus, a cron, a queue). The ADR does **not**
try to make these portable through a single interface in v1 — their
shapes differ too much across backends to abstract usefully yet. `poke`'s
signature is pinned by ADR 0006; the rest are sketched, not frozen.

### D. The `DjibbList` name and the `$djibb` alias

- The DO class keeps the name `DjibbList` per ADR 0011 §A (rename cost
  unbounded, clarity win bounded). But the **protocol's** type vocabulary
  adopts the honest names already present in `list/index.ts`
  (`ListElement`, `EntityRowType`, the `isEntityRow` guard). Extracting a
  package is the natural moment to let the *contract* read as "entity"
  while the *DO class* keeps its historical name — no conflict, since they
  now live in different packages.
- `pages/svelte.config.js`'s `$djibb → ../workers/src` alias is replaced by
  a normal package dependency on `@djibb/protocol`. This is the change that
  stops a frontend from reaching into the backend's source tree.

## Pros and cons against alternatives

### What the three-package split wins (vs the `$djibb` source alias today)

- **A real, importable contract.** A new frontend (or an LLM authoring one)
  depends on `@djibb/protocol` + `@djibb/client` and gets the entity model,
  the mutator vocabulary, and the runtime — without a build-time reach into
  Cloudflare worker source. "djibb-compatible frontend" becomes a published
  dependency edge, not tribal knowledge.
- **Backend portability becomes a one-interface job.** The `EntityStore`
  port is the whole persistence seam; everything above it is reused.
- **The protocol can't accrete Cloudflare deps by accident.** A package
  boundary with `zod`/`replicache`/`nanoid` as its only deps makes
  `import 'cloudflare:workers'` into protocol a build error, not a
  code-review catch.
- **The encodings (ADR 0012) and the registry stop being worker-internal.**
  `curl .../l/<id>.md`, "paste a NASA checklist," and agent-contributed
  Lists all consume `@djibb/protocol`'s `markdown.ts` directly.

### What keeping the `$djibb` alias would have won

- **Zero migration.** No package.jsons, no build wiring, no import churn.
- **One typecheck graph.** Today `npm run typecheck` (workers) and
  `npm run check` (pages) already span the boundary; three packages add
  project-reference plumbing.

The alias is fine for *one* frontend that happens to live next to the
backend. It does not survive "many interchangeable frontends, backend
bundled-or-distinct" — the moment a second frontend or a non-CF backend
appears, the alias is reaching into the wrong place. The split pays a
bounded one-time cost to remove an unbounded coupling.

### What a single `@djibb/core` (protocol+client merged) would have won

- **One fewer package.** Frontends import one thing.

Rejected: the client runtime carries `replicache` *construction*,
`partysocket`, and `IndexedDB`/`sessionStorage` assumptions that the
*backend* must never import, yet the backend needs the protocol. Merging
protocol into client would force the backend to depend on a browser
runtime. The split is along the actual dependency-direction fault line:
protocol is depended on by *both* client and backend; client and backend
never depend on each other.

### What a fat single port (storage + host together) would have won

- **One interface to implement per backend.**

Rejected: persistence (`EntityStore`) is a clean CRUD-shaped contract with
stable semantics; host capabilities (poke/alarm/RPC/emit) are
infrastructure-shaped and differ wildly across backends. Fusing them would
force every backend to stub realtime even when it only wants to run
mutators in a test. Decision C keeps them separable.

## Consequences

**Positive:**

- Frontends are interchangeable by construction: same `@djibb/client`,
  same registry, same entity schema; only presentation differs. The three
  use cases in `docs/use-cases.md` become three apps, not three forks.
- The backend is portable at the `EntityStore` seam; ADR 0015 (Effect as
  backend spine) plugs in *behind* this port without touching the protocol.
- Pure modules (`markdown.ts`, inverses, predicates, validation) move with
  zero code change — they were already dependency-free.
- The mutator-authoring discipline (`docs/adding-a-mutator.md`) is unchanged
  in substance; only the import path for storage helpers changes
  (`ctx.store.x()` instead of `import { x } from '../sql'`).

**Negative:**

- Real one-time migration: three `package.json`s, TS project references,
  build/test wiring per package, and an import sweep across
  `mutators/*.ts` (storage calls) and `pages/src` (`$djibb` → package).
  Bounded — the surface is small and the production footprint is tiny —
  but not free.
- `EntityStore` is a wide interface (~30+ methods). It is *discovered*, not
  designed (it is exactly today's `sql.ts`), so the width reflects real
  need, but a wide port is more to keep stable. Open question below.
- Host capabilities (Decision C) stay un-abstracted in v1, so a second
  backend re-implements realtime/alarms by hand. Accepted: that work is
  genuinely backend-specific and premature to abstract.
- Two firing paths and two reactivity assumptions (`@djibb/client` async
  fns vs the app's Svelte runes) must stay cleanly separated, or the
  "no Svelte in client" rule erodes.

## Alternatives considered

- **(a) Keep the `$djibb` source alias.** Fine for one frontend; does not
  survive many frontends or a non-CF backend. Covered above.
- **(b) Single merged `@djibb/core`.** Forces the backend to depend on a
  browser runtime. Rejected — wrong fault line.
- **(c) Fat storage+host port.** Forces every backend to stub realtime.
  Rejected — Decision C.
- **(d) Publish the protocol to a registry (npm) now.** Premature — there
  are no external consumers yet. Workspace-internal packages first;
  publishing is a later, separate decision once a third-party frontend
  exists.
- **(e) Generate the protocol surface from the OpenAPI/JSON-schema of the
  mutators rather than sharing TS.** Heavier, and loses the shared
  `client`/`inverse` *implementations* (not just types) that make optimistic
  updates and undo work. Rejected — the value is shared *code*, not shared
  *schemas* alone. (A published JSON schema is still worth emitting *for
  agents*; see Open questions.)

## Open questions

- **`EntityStore` granularity.** The port is today's `sql.ts` surface
  verbatim. Some methods (`updateListItemsFieldsAtomic`,
  `reorderChildElement`) encode list-specific semantics that a different
  backend might implement very differently. Decide at extraction time
  whether to keep the fat 1:1 port (mechanical, lower risk) or carve a
  narrower core (`get`/`put`/`appendLog`/`bumpVersion`) with the rest as
  protocol-side helpers built on the core. Recommendation: ship the fat 1:1
  port first (no behaviour change), narrow opportunistically.
- **Host-capability interface, when a second backend appears.** Decision C
  defers it. The first non-CF backend is what should drive its shape.
- **A published JSON-schema artifact for agents.** An LLM authoring a
  frontend benefits from a machine-readable dump of the entity schema + the
  mutator argsSchemas + the markdown grammar. `zod`→JSON-schema emission
  from `@djibb/protocol` is cheap and worth doing as part of the "easy
  agent frontends" goal — but it is an *output* of the protocol package,
  not a reason to restructure. Track separately.
- **Where `utils/trycatch` lives.** Imported by both pages and workers
  today. If ADR 0015 lands, Effect's typed errors may subsume it on the
  backend; the frontend still wants a lightweight `Result`. Likely a tiny
  shared util in `@djibb/protocol` or its own `@djibb/std`.
- **Test topology.** `@cloudflare/vitest-pool-workers` is needed only for
  `@djibb/server-cloudflare`. `@djibb/protocol` and `@djibb/client` should
  test under plain vitest (no workers pool, no `wrangler login`) — a
  welcome side effect, since pure-protocol tests stop needing the DO
  harness (cf. the memory note on workers-tests-need-wrangler-login).

## References

- ADR 0003 — DO as authority; D1 as derived index. The D1 emit is a
  backend-owned host capability (Decision C), not part of `EntityStore`.
- ADR 0005 — Undo via paired forward/inverse mutators. The `inverse` /
  `capturePreState` surface moves into `@djibb/protocol` unchanged.
- ADR 0006 — clientID-tagged websockets. The frame union is a protocol
  type; `poke` routing is a host capability.
- ADR 0011 — `DjibbList` as universal substrate. This ADR keeps the class
  name and packages the *contract* under honest entity-typed names.
- ADR 0012 — Markdown/JSON encodings. Already pure; moves into the protocol
  package as the agent-facing surface.
- ADR 0015 — Effect as backend spine. Plugs in behind the `EntityStore`
  port; deliberately *not* a protocol-package dependency.
- `workers/src/list/sql.ts` — the function surface promoted to
  `EntityStore`.
- `workers/src/list/mutators/_shared.ts`, `mutators/index.ts` — the
  `MutatorModule` contract and `executeServerMutation`.
- `pages/svelte.config.js` — the `$djibb → ../workers/src` alias this ADR
  replaces with a package dependency.
- `docs/use-cases.md`, `CONTEXT.md` — the many-frontends thesis this split
  serves.
