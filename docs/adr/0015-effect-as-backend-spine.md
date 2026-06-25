# ADR 0015: Effect as the backend spine; Zod stays the protocol schema

- **Status:** Proposed
- **Date:** 2026-06-14
- **Layer:** server-cf

## Context

ADR 0014 splits the codebase into `@djibb/protocol` (pure contract),
`@djibb/client` (framework-agnostic runtime), and
`@djibb/server-cloudflare` (authoritative backend), and introduces the
`EntityStore` port as the persistence seam. The open question that ADR
deliberately punted: *what runs behind the port?* The backend today is a
3,037-line Durable Object plus hand-rolled fallible plumbing —
`utils/trycatch.ts`'s `Result` type wrapping D1 emits, OAuth, email,
and the reconciliation sweeper.

Effect (`effect`, `@effect/sql`, `@effect/platform`) is on the table as
the backend's concurrency / error / SQL spine. A vendored copy lives at
`repos/effect/` for reference (read-only; application code depends on the
published packages, not the vendored source — `repos/CLAUDE.md`).

Two facts make Effect specifically attractive *here* and not generically:

1. **The Effect SQL ecosystem already targets our exact runtime.** The
   vendored repo ships `@effect/sql-sqlite-do` — an Effect SQL driver for
   **Durable Object SQLite** — and `@effect/sql-d1` for D1. These are
   near-purpose-built to implement the `EntityStore` port (over DO SQLite)
   and the derived-index writer (over D1), with one typed, composable SQL
   API that also runs over libSQL / Postgres / node-sqlite. That directly
   serves ADR 0014's "backend bundled-or-distinct from Cloudflare."

2. **Our failure model is already a typed union.** ADR 0005/0006 defines
   the per-mutation outcome channel as `auth | stale | gone | ok`, and
   `EntityStore` methods already return `'applied' | 'stale' | 'gone'`.
   That is an Effect typed-error channel waiting to happen — today it is
   threaded by hand through `Result` and discriminated-union returns.

The risk Effect carries is equally specific: it is a *paradigm*, and
paradigms spread. The discipline this ADR exists to impose is **where
Effect is allowed to live**, so it strengthens the backend without
leaking into the protocol or the frontends.

## Decision

### A. Effect is a backend-only spine, behind the `EntityStore` port

Effect lives **only** in `@djibb/server-cloudflare` (and any future
backend package). It is *not* a dependency of `@djibb/protocol` or
`@djibb/client`. The boundary is ADR 0014's port: above the port is pure,
Effect-free contract code shared with every frontend; below it, the
backend may be as Effect-native as it likes.

Concretely, Effect is adopted for the backend's genuinely *effectful,
fallible, retryable* edges — and nothing else:

- **The `EntityStore` implementation**, via `@effect/sql-sqlite-do` over
  the DO's `SqlStorage`. The port's methods become Effect SQL queries;
  the adapter (`createSqlStorageEntityStore`) is where Effect meets the
  Cloudflare runtime.
- **The D1 derived-index emit and the reconciliation sweeper** (ADR 0003 /
  ADR 0007), via `@effect/sql-d1`, with Effect's built-in retry/schedule
  replacing the hand-rolled "retry on next mutation / alarm backstop"
  bookkeeping.
- **The outward edges**: email send (Cloudflare Email, per the
  cloudflare-email-service memory), OAuth (`arctic`), magic-link issuance.
  These are textbook `Effect<A, E, R>` with typed errors and a `Layer` for
  the external dependency.

### B. Server mutator *bodies* stay plain; the host *orchestration* is Effect

A server mutator body (`setItemFields`'s `server` fn is one line:
`store.updateListItemFields(...)`) stays a plain function over the
`EntityStore` port. It does **not** return an `Effect`. The protocol
defines `ServerMutator` as a synchronous function returning the outcome
union, and that signature lives in `@djibb/protocol` — making it return
`Effect` would pull Effect across the port.

Effect enters at the **host** layer that *drives* mutators: the DO push
handler that parses the envelope, gates role, calls
`executeServerMutation`, then fans out the side effects (log append, D1
emit, poke, alarm scheduling, sibling-DO RPC). That orchestration —
sequencing fallible steps, typed errors, retry, the `Layer` graph wiring
`EntityStore` + email + D1 + clock — is exactly Effect's wheelhouse and
exactly where today's `tryCatch`/`Result` sprawl lives.

This keeps the per-mutator surface (which an author touches constantly,
and `docs/adding-a-mutator.md` documents) free of Effect, while the host
(touched rarely, infrastructure-shaped) gets the full benefit.

### C. Zod stays the protocol's schema language — **no** migration to Effect Schema

The entity schemas, every mutator `argsSchema`, the auth-rules schema,
and the wire shapes are Zod (v4) and live in `@djibb/protocol`. They
**stay Zod**. Effect Schema is explicitly **not** adopted, for a reason
that follows directly from Decision A:

**This is *not* a licensing-openness argument.** Zod and Effect are *both
MIT* — keeping Zod buys the protocol nothing on the "open" axis, and any
reasoning that picks Zod "to stay open" is confused. The protocol's
*Apache* license (ADR 0016) is independent of which MIT schema lib it
imports. The decision rests only on the three axes where the two libraries
actually differ:

- **Ubiquity / familiarity — including LLM training-data density.** Far more
  Zod than Effect Schema exists in model training corpora today, so an LLM
  authoring a frontend against `@djibb/protocol` writes correct Zod far more
  reliably. This directly serves ADR 0014's "agents whip off frontends"
  goal. **But this is a *bet on the current state*, not a principle** — see
  the revisit trigger below.
- **Bundle weight.** Effect Schema is tree-shakeable and usable
  semi-standalone, but it still pulls the Effect core; for a contract every
  frontend imports, that is a real cost Zod does not impose. Structural, so
  more durable than the ubiquity axis — though Effect's modularity narrows
  it.
- **Paradigm-neutrality.** A frontend importing Zod commits to nothing but
  data validation; importing Effect Schema seats the consumer in an
  ecosystem that pulls toward adopting Effect wholesale. The shared contract
  should not nudge consumers into a paradigm. This is the *most durable*
  reason and the one that survives even if Effect wins on popularity.

- **The win is also marginal today.** Effect Schema's headline advantages —
  bidirectional encode/decode, branded types — are real, but the protocol
  *already* has its encode/decode story (`markdown.ts` + JSON, ADR 0012),
  and Zod v4 covers the validation need on both client (optimistic) and
  server (authoritative) paths. The seam is clean without one shared lib:
  the backend push handler parses the wire with Zod → plain TS values →
  hands them to the Effect program. Zod validates at the boundary; Effect
  orchestrates the effects.

**Revisit trigger (the bet's expiry).** Reopen this decision if *either*:
(1) **Effect Schema becomes the de-facto TS schema standard** — at which
point the ubiquity axis flips (Effect Schema becomes the low-friction choice
for humans *and* LLMs), the bundle-weight axis shrinks toward zero (everyone
is pulling Effect anyway), and only paradigm-neutrality remains, itself
weakened in an Effect-normalized ecosystem; or (2) **the backend's Effect
adoption makes one schema lib across the port save real duplication.** The
migration is cheap and reversible — the load-bearing asset is the *shape* of
the schemas (the entity model, the argsSchemas), not the library expressing
them, so a Zod→Effect-Schema port is largely mechanical. A useful
de-risking asymmetry: Decision A/B already let the backend run Effect freely
behind the port, and an Effect backend consumes Zod schemas fine — so a
half-Effect future does *not* force the protocol's hand. Only a future where
*frontends and LLMs overwhelmingly prefer Effect Schema natively* triggers
the flip.

If a future backend-only need wants Effect Schema *internally* (e.g.
decoding a third-party API response inside an Effect program), that is
allowed **inside `@djibb/server-cloudflare`** today — it just never crosses
the port into protocol.

### D. Incremental adoption order — edges first, never a big-bang rewrite

Effect is introduced strangler-fig style, lowest-risk edge first, each
step shippable and independently revertible:

1. **D1 emit + reconciliation sweeper** (`@effect/sql-d1`). Self-contained,
   already isolated, already retry-shaped — the ideal first convert. Proves
   the `Layer` + `Schedule` ergonomics with no user-facing risk.
2. **Email / OAuth / magic-link** outward edges. Typed errors replace
   ad-hoc throws; `Layer` makes the external dep mockable in tests without
   the workers pool.
3. **`EntityStore` implementation** over `@effect/sql-sqlite-do`, behind
   the ADR 0014 port. Mutator bodies unchanged.
4. **Push-handler orchestration** (Decision B). The last and largest;
   only after 1–3 have established the patterns.

Mutator *bodies*, the protocol, and the frontends are never rewritten.

## Pros and cons against alternatives

### What Effect-as-backend-spine wins (vs the status quo `tryCatch`/`Result`)

- **The failure model becomes the type system's job.** `auth | stale |
  gone` stops being a hand-threaded discriminated return and becomes a
  typed error channel the compiler tracks across the host's fan-out.
- **One SQL API across backends.** `@effect/sql-sqlite-do` /
  `@effect/sql-d1` / libSQL / Postgres share an interface — the
  `EntityStore` port gets a portable implementation, not a CF-only one.
- **Retry/schedule/timeout are library features.** The sweeper's "retry on
  next mutation, alarm backstop" and the D1 emit's downgrade-hazard guard
  (ADR 0007) are expressed declaratively instead of by hand.
- **`Layer`-based DI makes the backend testable off the workers pool.**
  The external deps (D1, email, clock) become swappable layers.

### What the status quo wins (vs adopting Effect)

- **No new paradigm to learn or contain.** `tryCatch`/`Result` is small and
  already understood; Effect has a real learning curve and a gravitational
  pull the team must actively resist (Decision A/B/C exist precisely to
  resist it).
- **Smaller dependency + bundle on the worker.** Effect is not tiny;
  a Cloudflare Worker has size budgets. Must be measured before step 3.
- **No migration cost.** The status quo ships today.

The status quo's wins are all "no change is cheaper than change." They are
real but bounded; the backend's fallible-edge sprawl is the steady cost
Effect removes, and the SQL-portability win is load-bearing for ADR 0014's
backend-portability goal.

### What full Effect adoption (frontend + protocol + Effect Schema) would have won

- **One paradigm everywhere; one schema library; uniform error handling.**

Rejected — this is the trap. It makes `effect` a dependency of the wire
contract and every frontend, defeating ADR 0014's neutral-protocol thesis,
and forces a Zod→Schema migration with near-zero product payoff. Decisions
A and C draw the line at the port deliberately.

### What "just keep hand-rolling `Result`, add a tiny retry helper" would have won

- **Minimal footprint; no Effect at all.**

Tenable, and the honest fallback if step 1's bundle-size or ergonomics
measurement disappoints. But it leaves the SQL layer CF-specific (no
`sql-sqlite-do`/`sql-d1` portability) and keeps reimplementing
schedule/retry/DI that Effect provides off the shelf. Recorded as the
revert target, not the plan.

## Consequences

**Positive:**

- The backend gains a typed, portable, retry-aware spine; ADR 0014's
  `EntityStore` port gets a portable implementation rather than a CF-only
  one.
- The protocol and frontends are provably unaffected — Effect cannot reach
  them across the port (Decision A) and Zod stays the schema language
  (Decision C).
- Adoption is reversible at every step (Decision D); step 1 alone is a
  contained, low-risk proof.

**Negative:**

- Effect's learning curve and its tendency to spread — mitigated by the
  hard boundary, but a real ongoing discipline.
- Worker bundle size must be measured before the `EntityStore`/host steps;
  if it blows the budget, fall back to the "tiny retry helper" alternative.
- A period of *two* idioms on the backend (Effect at converted edges,
  `tryCatch` elsewhere) during the strangler migration. Accepted as the
  cost of not doing a big-bang rewrite.
- `@effect/sql-sqlite-do` / `@effect/sql-d1` are relatively young; their
  stability on the Workers runtime must be validated in step 1/3, not
  assumed.

## Alternatives considered

- **(a) Status quo `tryCatch`/`Result` forever.** The revert target; loses
  SQL portability and off-the-shelf retry/DI. Above.
- **(b) Full Effect adoption incl. frontend + Effect Schema in protocol.**
  Defeats ADR 0014's neutral protocol; rejected (Decision A/C).
- **(c) Effect in protocol's `ServerMutator` signature** (mutator bodies
  return `Effect`). Pulls Effect across the port into shared contract code;
  rejected (Decision B).
- **(d) Effect Schema instead of Zod, backend-only, with a Zod protocol
  boundary.** Two schema libraries to maintain and a translation layer at
  the edge; rejected for v1 — Zod-at-the-edge → plain-values → Effect is
  simpler. Effect Schema is permitted only for backend-internal decoding
  that never crosses the port.
- **(e) A different effect/FP lib (fp-ts, neverthrow).** `neverthrow` is
  just a nicer `Result` (no SQL/Layer/Schedule ecosystem); `fp-ts` is
  Effect's predecessor without the runtime. Neither brings the
  `sql-sqlite-do`/`sql-d1` drivers that make Effect specifically apt here.

## Open questions

- **Worker bundle-size budget** with `effect` + `@effect/sql-*` included.
  Measure in step 1 before committing to steps 3–4.
- **`@effect/sql-sqlite-do` transaction semantics vs the DO's
  synchronous `SqlStorage`.** djibb's mutators run synchronously inside the
  DO's single-threaded turn; confirm the Effect SQL driver preserves that
  atomicity model (one mutation = one transaction = one log row) rather than
  introducing async interleaving across the turn boundary.
- **How much of the host fan-out (poke, alarm, sibling-RPC) becomes
  `Layer`s vs stays raw DO API.** Decision B says "orchestration is
  Effect," but the CF-native calls (`acceptWebSocket`, `ctx.storage.setAlarm`,
  stub RPC) may be thinner as direct calls inside an Effect than as full
  service layers. Decide per edge during step 4.
- **Testing topology.** Effect's `Layer`-mocking could let much of the
  backend test under plain vitest; how much still genuinely needs
  `@cloudflare/vitest-pool-workers` (and a wrangler login) is worth
  re-measuring once step 1–2 land.

## References

- ADR 0014 — Protocol/client/backend split + the `EntityStore` port. This
  ADR fills in "what runs behind the port." Effect is barred from crossing
  it.
- ADR 0003 — DO-as-authority + D1 derived index. The emit is an early
  Effect convert (step 1).
- ADR 0005 / 0006 — the `auth | stale | gone | ok` outcome model that maps
  onto Effect's typed error channel.
- ADR 0007 — D1 reconciliation sweeper; first Effect `Schedule` target.
- ADR 0012 — Markdown/JSON encodings; why the protocol does not need Effect
  Schema's encode/decode.
- `workers/src/utils/trycatch.ts` — the hand-rolled `Result` Effect
  replaces at the backend edges.
- `repos/effect/packages/sql-sqlite-do`, `repos/effect/packages/sql-d1` —
  the vendored drivers that make Effect specifically apt for this runtime
  (reference-only per `repos/CLAUDE.md`).
- Memory: cloudflare-email-service, workers-tests-need-wrangler-login —
  edges that Effect `Layer`s would make mockable off the workers pool.
