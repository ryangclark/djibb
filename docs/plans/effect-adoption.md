# Effect adoption plan (implements ADR 0015)

- **Status:** **COMPLETE (2026-07-11).** Phases 0–2 landed; Phase 3 declined
  (2026-07-10, ADR 0015 Amendment 6); Phase 4 shipped as a decomposition
  with its Effect pipeline declined (2026-07-11, Amendment 7). Effect's
  realized scope is the D1 owner modules (`derived-index/d1.ts`,
  `auth/d1.ts`) and the outward edges (`EmailSender`, `GoogleIdentity`) —
  the places with real async, real retry, and real external failure. It did
  not enter the DO's synchronous host, and that is the finding, not a gap.
  ADR 0015 is **Accepted**.
- **Date:** 2026-07-09 (updated 2026-07-11)
- **Layer:** server-cf only (ADR 0015 Decision A — Effect never crosses into
  `@djibb/protocol` or `@djibb/client`)

## What changed since ADR 0015 was written (2026-06-14)

The ADR's decisions all still hold, but three landings reshaped the terrain
its adoption steps were drawn on. This plan is the ADR's Decision D
re-plotted onto the current codebase.

1. **The ADR 0014 split is done.** The port the ADR calls `EntityStore` is
   now two named things: `MutatorStore` (the mutator-facing surface, in
   `packages/protocol/src/list/store.ts`) and the backend's structural
   superset `EntityStore` (`packages/server-cf/src/list/store.ts`). The
   Effect-free boundary the ADR demands already exists.

2. **ADR 0025 (D1 storage discipline) pre-dug Effect's trench.** All D1 SQL
   now lives in exactly two owner modules — `derived-index/d1.ts` and
   `auth/d1.ts` — as named free functions `(db: D1Database, ...) => Promise<T>`
   with zod-at-the-seam and `DjibbError`-only failures. ADR 0025 explicitly
   designates the Effect drivers as "an internal swap behind the same named
   operations, invisible to callers." So the ADR's step 1 ("convert the D1
   emit + sweeper") becomes: **re-implement the owner modules' internals over
   `@effect/sql-d1`, keeping every exported signature**. Callers never know.

3. **`tryCatch`/`Result` moved and shrank.** The ADR cites
   `workers/src/utils/trycatch.ts` sprawl; today `Result` lives in
   `@djibb/protocol/trycatch` and its remaining backend uses are the five DO
   RPC boundaries in `durable_object.ts` — where the return value must be
   structured-clone-serializable (see memory: DO RPC returns). `Result` is
   therefore a **wire envelope, not sprawl to eliminate**: every Effect
   program ends in `Effect.runPromise*` *before* the RPC return, and
   `tryCatch(Async)` stays as the envelope. The ADR's "replaces the
   tryCatch/Result sprawl" framing should be amended to "replaces hand-rolled
   orchestration/retry; `Result` remains the RPC serialization shape."

4. **ADR 0026 (DO decomposition) sequences Phase 4.** The push-handler
   orchestration convert (ADR step 4) must ride *after* the workspace +
   invitations module carve, so the 3,288-line `durable_object.ts` is
   visited in the right order — decompose first, then Effect-ify the host.

## Two corrections to the ADR's expectations

**(a) `Schedule` does not replace the reconcile alarm.** The ADR suggests
Effect's retry/schedule replaces the sweeper's "retry on next mutation /
alarm backstop" bookkeeping. It can't: the day-cadence reconcile and its
exponential backoff (`RECONCILE_RETRY_KEY`, re-arm via the multi-event alarm
dispatcher) are **durable DO-storage state** — a DO can't hold an in-process
`Schedule` across hibernation. Effect `Schedule` applies to *short,
in-request* retries (transient D1 errors inside one emit), not the alarm.
The alarm dispatcher stays exactly as is.

**(b) Step 3 (EntityStore over `@effect/sql-sqlite-do`) collides with
Decision B.** `MutatorStore`'s methods are *synchronous* — mutators run sync
inside the DO turn, one mutation = one implicit transaction, and the whole
outcome model depends on that atomicity. `@effect/sql-sqlite-do` exposes an
async Effect API. The only way to keep the sync contract is
`Effect.runSync` over the (synchronous) `SqlStorage.exec` — plausible but
fragile: any layer that introduces a promise tick (telemetry, driver
internals) breaks `runSync` at runtime, not compile time. This is the ADR's
own open question, now sharpened: **Phase 3 is gated on an empirical spike,
and "never do it" is an acceptable outcome** — `list/sql.ts` staying raw
`SqlStorage` is fine (it's synchronous, simple, and behind named
operations); portability can come later as a second backend package.

## Phases

Each phase is shippable, independently revertible, and lands behind
unchanged public signatures. The regression net throughout is the existing
workers-pool test suite (wrangler login required — see memory) plus the
ADR 0025 guard test.

### Phase 0 — Gates and spikes (no product code changes)

1. **Add deps** to `packages/server-cf` only: `effect`, `@effect/sql`,
   `@effect/sql-d1` (published versions — the vendored `repos/effect` is
   reference-only; snapshot there is effect 3.21.3 / sql-d1 0.49.0 /
   sql-sqlite-do 0.29.0, so check for newer).
2. **Bundle-size gate.** `wrangler deploy --dry-run --outdir` before/after
   importing the Effect runtime + one sql-d1 query in the worker entry.
   Record raw + gzip deltas in this doc. If the delta threatens the Worker
   size budget, stop and fall back to the ADR's recorded revert target
   ("tiny retry helper").
   > **Measured 2026-07-09** (wrangler 4.99.0; effect 3.21.4 + @effect/sql
   > 0.51.1 + @effect/sql-d1 0.49.0 via `src/effect/probe.ts`):
   > baseline 999.21 KiB raw / 175.99 KiB gzip → with Effect 1819.01 KiB
   > raw / 325.20 KiB gzip. **Delta +819.8 KiB raw / +149.2 KiB gzip.**
   > Against the Workers gzip limits (3 MiB free / 10 MiB paid) this
   > leaves ample headroom. **Gate: PASS.**
3. **Runtime proof on workerd.** One throwaway vitest-pool-workers test
   running an Effect sql-d1 query against miniflare D1. Proves the runtime
   (fibers, FinalizationRegistry use, etc.) behaves under workerd.
   > **Measured 2026-07-09** (`test/effectSpike.test.ts`): PASS — the
   > Effect runtime + `@effect/sql-d1` layer build, query, and
   > `runPromise` all work inside workerd via the workers pool.
4. **`runSync` spike for Phase 3's gate.** In the test pool, drive
   `@effect/sql-sqlite-do` over a real DO `SqlStorage` and attempt
   `Effect.runSync` on a query + a multi-statement transaction. Outcome
   (works / async-only) decides Phase 3's fate. Timebox: half a day.
   > **Measured 2026-07-09** (`test/effectSpike.test.ts`), three findings:
   > 1. **Plain queries under `Effect.runSync` WORK** — client build
   >    (`SqliteClient.make` + Reactivity layer), DDL, writes, and reads
   >    all complete synchronously; no `AsyncFiberException`.
   > 2. **The driver's `withTransaction` is INCOMPATIBLE with DO SQLite.**
   >    `@effect/sql` emits literal `BEGIN`/`SAVEPOINT`, and the runtime
   >    rejects it: *"To execute a transaction, please use the
   >    state.storage.transaction() or transactionSync() APIs instead of
   >    the SQL BEGIN TRANSACTION or SAVEPOINT statements."* This holds on
   >    real workerd, not just miniflare — it is the DO storage API.
   > 3. **The idiomatic composition works:** the host wraps the whole
   >    Effect program in `storage.transactionSync(() =>
   >    Effect.runSync(program))` — atomicity and rollback confirmed.
   >
   > **Verdict: Phase 3 is viable in qualified form** — sync
   > `MutatorStore` contract preserved via `runSync`; atomicity stays a
   > *host* concern (`transactionSync`, matching today's one-mutation-
   > one-turn model); `sql.withTransaction` must never be used against
   > DO SQLite. Whether the ceremony is worth it over raw `SqlStorage`
   > remains a Phase 3 judgment call, but the gate is no longer "can't."
5. **Decide the runtime topology.** Workers have no long-lived global; plan
   is a `ManagedRuntime` memoized per isolate for worker-side D1 work
   (keyed on the `D1Database` binding) and per DO instance for DO-side
   work. Validate teardown semantics in the spike.
   > **Decision 2026-07-09:** the spike ran fine with per-call
   > `Effect.provide(D1Client.layer(...))` / per-call `SqliteClient.make`.
   > Phase 1 starts with that simplest shape (layer built per named
   > operation) and introduces a memoized `ManagedRuntime` only if
   > profiling shows layer-build cost matters; premature caching across
   > requests risks leaking scopes across workerd request contexts
   > (workerd disallows cross-request promise reuse).
6. **Boundary guard test** (mirror of ADR 0025's): fails if
   `from 'effect'` / `from '@effect/` appears anywhere in
   `packages/protocol` or `packages/client`. Lands before the first real
   convert so the discipline is mechanical from day one.

**Exit criteria:** bundle delta recorded and acceptable; workerd proof
green; runSync verdict recorded; guard test merged.

> **Phase 0 complete 2026-07-09. All gates PASS.** Artifacts:
> `packages/server-cf/src/effect/probe.ts` (+ dev-only `/__effect-probe`
> route in `src/index.ts`), `test/effectSpike.test.ts` (workerd proof +
> runSync spike), `test/meta/effectBoundary.test.ts` (boundary guard).
> Deps added to server-cf only: effect 3.21.4, @effect/sql 0.51.1,
> @effect/sql-d1 0.49.0, @effect/sql-sqlite-do 0.29.0. Full suite green
> (527 tests / 59 files) + all three tsconfigs. Probe + spike test are
> deleted when Phase 1 lands; the guard test is permanent. **Phase 1
> (derived-index/d1.ts internals → @effect/sql-d1) is unblocked.**

### Phase 1 — `derived-index/d1.ts` internals → `@effect/sql-d1`

The ideal first convert, as the ADR predicted — but now shaped by ADR 0025:

- Every exported named operation (`EmitEntitySnapshotToCatalog`,
  `EmitInvitationsSnapshot`, `GetEntityVersion`, the list/catalog readers,
  ~24 functions) keeps its exact `(db, ...) => Promise<T>` signature and
  `DjibbError` failure surface.
- Internals become Effect programs: `SqlClient` from `@effect/sql-d1`,
  tagged errors (`SqlError` → mapped to the module's `DjibbError`s at the
  `runPromise` boundary), zod parse stays at the seam per ADR 0025.
- `Effect.Schedule` gets its first real use on *in-request* transient-error
  retry inside the emit operations (bounded, e.g. 2 retries with jitter) —
  the alarm-driven backstop in the DO is untouched (correction (a)).
- The ADR 0025 vitest guard (`.prepare(`/`.batch(` allowlist) keeps passing
  by construction — the driver's prepares live in `node_modules`.
- Compound operations that use `db.batch()` (invitation accept et al.) map
  to the sql-d1 driver's batch/transaction support; verify the driver
  preserves D1's single-batch atomicity before converting those, and
  convert read-only operations first.

**Exit criteria:** all workers tests green; no exported signature changed;
diff is confined to `derived-index/d1.ts` + a new `effect/` support module
(runtime memoization, error mapping — the one place `runPromise` ceremony
lives).

> **Phase 1 complete 2026-07-09.** All ~24 named operations in
> `derived-index/d1.ts` keep their exact `(db, ...) => Promise<T>`
> signatures; internals are Effect programs run through the new
> `src/effect/d1.ts` support module (`runD1`: per-call D1Client layer,
> SqlError/defect → `UnexpectedError` mapping at the boundary;
> `transientD1Retry`: 2 jittered-exponential retries, opted into by the
> idempotent emits; `d1Try`: lifts raw D1 calls into the SqlError
> channel). Verified per-call layer topology per the Phase 0 decision —
> no memoized `ManagedRuntime`.
>
> **Batch finding (the "verify before converting" item above):** the
> `@effect/sql-d1` driver has **no batch/transaction support at all** —
> its `transactionAcquirer` dies with "transactions are not supported
> in D1", and nothing in it calls D1 batch. It also discards `meta`
> from results. So the batch-atomic compound writes
> (`EmitEntityMembershipsToCatalog`, `EmitInvitationsSnapshot`,
> `MarkInvitationsAccepted`) and the `meta.changes`-inspecting
> `tryClaimSlug` UPDATE keep the raw D1 API for those specific calls,
> lifted into the same Effect programs via `d1Try` so they share the
> retry + error mapping. D1's single-batch atomicity is preserved by
> construction.
>
> Phase 0 artifacts removed as planned (`src/effect/probe.ts`, the
> `/__effect-probe` route, `test/effectSpike.test.ts`); the support
> module has its own standing workerd test (`test/effectD1.test.ts`).
> Full suite green: 531 tests / 59 files, all three tsconfigs. Bundle
> re-measured with the real convert: 1692.31 KiB raw / 311.23 KiB gzip
> (below the Phase 0 probe measurement — the probe's dynamic-import
> chunk is gone). ADR 0015 flipped to **Accepted** with the amendments
> section. **Phase 2 (`auth/d1.ts` + outward edges) is unblocked.**

### Phase 2 — `auth/d1.ts` + outward edges (email, OAuth, magic link)

- `auth/d1.ts`: same treatment as Phase 1, now routine.
- **Email**: define an `EmailSender` Effect service whose live `Layer` wraps
  `env.EMAIL` (keeps the thin interface the cloudflare-email-service memory
  wants). Typed `EmailSendError`; bounded `Schedule` retry on transient
  failures in the DO's `fireInvitationEmails` / `fireOwnershipTransferEmails`
  send loops. The test `Layer` finally makes these paths assertable without
  the workers pool.
- **OAuth (`arctic`) + magic link**: typed error channel replaces ad-hoc
  throws in `auth/oauth.ts` / `auth/magic.ts`; external deps become Layers.
- **Testing-topology measurement** (ADR open question): after this phase,
  count which tests still genuinely need `@cloudflare/vitest-pool-workers`
  vs plain vitest with test Layers. Record the answer in the ADR.

> **Phase 2 complete 2026-07-10.** Four pieces:
>
> 1. **`auth/d1.ts` converted** — same treatment as Phase 1, and it was
>    indeed routine: every named operation keeps its exact
>    `(db, ...) => Promise<T>` signature; internals run through `runD1`.
>    Same carve-outs as Phase 1: batch-atomic writes (`CreateSession`,
>    `DeleteSession`) and `meta`-inspecting statements
>    (`updateSessionExpiration`, `RevokeEntityBoundCredential`,
>    `UpdateAccountUsername`) stay on the raw D1 API via `d1Try`;
>    `UpdateAccountUsername` returns a discriminant from the program and
>    throws its domain errors (`NotFoundError`/`FailedPreconditionError`)
>    outside `runD1`, mirroring `tryClaimSlug`. `UPDATE…RETURNING`
>    (`consumeMagicTokenRow`) works through the driver (it executes via
>    `.all()`). Zod/shape parses stay outside the programs so
>    `ParseError` keeps its own surface. No transient retry anywhere in
>    the auth substrate — nothing there is an idempotent emit; the user
>    is the retry loop. Two reads that previously rethrew raw driver
>    errors (`GetAccountByEmail`, `GetAccountByGoogleId`) now surface
>    `UnexpectedError` like the rest of the module — a deliberate
>    alignment with ADR 0025's DjibbError-only contract.
> 2. **`EmailSender` service** (`src/effect/email.ts`): live `Layer`
>    wraps the `EMAIL` binding; typed `EmailSendError`; bounded
>    `transientEmailRetry` (2 jittered retries — kept small because
>    sends aren't idempotent: a duplicate email beats a dropped one, but
>    barely). Message construction extracted as pure `build*Email`
>    functions; `src/email` keeps its `(env, params) => Promise<void>`
>    senders via `runEmailSend` (the email `runPromise` ceremony). The
>    DO's `fireInvitationEmails`/`fireOwnershipTransferEmails` loops are
>    untouched — they get the retry through the senders they already
>    call, and keep their best-effort catch-and-log posture. New
>    plain-node test `test/meta/effectEmail.test.ts` asserts copy,
>    escaping, capture-Layer sends, and retry bounds without the pool.
> 3. **`GoogleIdentity` service** (`src/effect/oauth.ts`): the OAuth
>    callback's external interaction (arctic code exchange + userinfo
>    fetch + claims parse — the fetch was previously unguarded) is one
>    named operation with typed `OAuthExchangeError`/`OAuthClaimsError`;
>    the Hono handler maps both to `UnexpectedError` at the HTTP
>    boundary. Magic link needed no new seam: its external deps are the
>    auth substrate (converted above) and email (the service); its
>    handler throws are the HTTP contract, not ad-hoc.
> 4. **Testing-topology measurement** recorded as ADR 0015 Amendment 5:
>    48/60 files genuinely need the pool (real D1/DO/fetch), 3 are
>    plain-node meta, 9 are pure logic incidentally in the pool. No
>    migration planned.
>
> Full suite green: 540 tests / 60 files, all three tsconfigs. **Phase 3
> (gated) and Phase 4 (after the ADR 0026 carve) remain.**

### Phase 3 — GATED: `list/sql.ts` / `EntityStore` over `@effect/sql-sqlite-do`

Proceeds **only if** Phase 0's runSync spike succeeded *and* the bundle gate
still has headroom (this pulls the driver into the DO bundle).

- `MutatorStore` stays synchronous (Decision B is inviolable); `sql.ts`
  named operations keep sync signatures via `Effect.runSync`.
- One mutation = one transaction = one log row must be preserved; add a
  direct test asserting no async interleaving across the turn boundary.
- If the spike failed: record "Phase 3 declined" as an amendment on ADR 0015
  — raw `SqlStorage` behind named operations *is* the port discipline
  already, and a future portable backend package is the cleaner route to
  the SQL-portability win.

> **Phase 3 DECLINED 2026-07-10.** The spike passed only in qualified form
> (Phase 0 finding 4), and evaluating the convert against the real
> `list/sql.ts` (~50 named operations, ~2,050 lines) confirmed the ceremony
> buys nothing: the operations are synchronous by contract (Decision B), so
> Effect is `runSync` over sync code; the transaction win is unavailable
> (`withTransaction` rejected by DO SQLite — atomicity stays host-owned);
> no in-request retry applies (single-threaded, one-turn); no
> Layer-mockability win (Amendment 5 — these test against real DO storage in
> the pool); and the error surface is already `DjibbError` behind already-
> named operations, so the ADR 0014 port discipline the convert would "buy"
> already exists. Residual "one SQL API across backends" is better served by
> a future portable backend *package* than by wrapping DO SQLite in
> `runSync`, which would also pull `sql-sqlite-do` into the DO bundle and
> add a second idiom to the hottest path. Recorded as **ADR 0015 Amendment
> 6**; the unused `@effect/sql-sqlite-do` dep (Phase 0 spike leftover) was
> removed from `packages/server-cf`. `list/sql.ts` stays raw `SqlStorage`.
> **Only Phase 4 (push-handler orchestration) remains, gated on the ADR
> 0026 DO carve.**

### Phase 4 — Push-handler orchestration (after the ADR 0026 carve)

The last and largest, exactly as the ADR ordered — with the added
prerequisite that ADR 0026's workspace + invitations modules are carved
first, so Effect lands on a ~2,000-line navigable DO, not the 3,288-line
current one.

- `_handlePush`'s post-commit fan-out (mutation-log bookkeeping, D1
  snapshot/invitations emits, email fires, poke, alarm ensure) becomes one
  Effect pipeline with the `auth | stale | gone` outcome as the typed
  channel.
- CF-native calls (`poke`, websocket accept, `ctx.storage.setAlarm`, sibling
  DO stub RPC) stay direct calls wrapped in `Effect.promise`/`Effect.sync` —
  not full service Layers — unless a test needs to swap one (per-edge
  decision, per the ADR's open question).
- The RPC boundary keeps its shape: `tryCatchAsync(runtime.runPromise(program))`
  so `Result` remains the serializable envelope (change (3) above).
- The mutator author surface (`docs/adding-a-mutator.md`) is provably
  untouched — mutator bodies never see Effect.

> **Phase 4 shipped 2026-07-11 as a decomposition; the Effect pipeline is
> DECLINED (ADR 0015 Amendment 7).** The phase had two halves hiding inside
> one bullet, and they came apart cleanly once the ADR 0026 carve was done.
>
> **What shipped — the intent fold (ADR 0026 series 3).** Series 1 and 2
> carved the tail's *execution* into `workspace/cascade.ts` and
> `list/notifications.ts`, each taking a flags object. But the
> *accumulation* of those flags was still inline in the DO's mutation loop:
> nine mutable `let`s and ~140 lines of arg-fishing tangled into the loop's
> Replicache bookkeeping — the last hand-rolled orchestration in the DO, and
> the thing step 4 was actually reaching for. It is now a pure fold:
> `PostCommitIntent` in `list/postCommit.ts`, committed mutations in, one
> intent out, projected onto the two tails by `invitationFlags()` /
> `workspaceFlags()`. `ENTITY_METADATA_MUTATORS` / `INVITATION_MUTATORS`
> moved with it. Semantics preserved exactly, sharp edges included
> (`didMutate` as the gate, last-write-wins on harddelete/startFresh, the
> same-owner `transferOwnership` no-op stays filtered). DO 2,561 → 2,299 LOC.
> The fold is pure, so the fiddliest logic in the push path is now asserted
> in the plain-node `meta` project — 25 tests, no pool, no wrangler login,
> 890ms. Suite: 583 tests / 63 files green.
>
> **What did not ship — the Effect pipeline.** Against the real post-carve
> tail (seven lines of straight-line `await`s), every Effect value
> proposition fails structurally: the tail is *deliberately* fire-and-pray
> so there is no error to type; retry already lives inside the calls it
> makes (`transientD1Retry`, `transientEmailRetry`) and wrapping it again
> would double-retry; the deps are already injected so Layers buy no
> mockability; and the `auth | stale | gone` outcome rides the *synchronous*
> `handleMutation` path, where Effect is `runSync` ceremony — Phase 3's
> finding, in the same file. Structured concurrency, the one win on offer,
> is blocked by load-bearing ordering (snapshot before cascade;
> `MarkInvitationsAccepted` before the reconciler's diff). Recorded as **ADR
> 0015 Amendment 7**; Decision D is complete with steps 3 and 4 not taken.
>
> **Finding, logged not fixed — notification emails are on the push's
> critical path.** `fireInvitationEmails` / `fireOwnershipTransferEmails`
> are awaited inside `_handlePush`, so a user's push ack waits on outbound
> email network calls. These are best-effort notifications; nothing about
> the DO's consistency needs them awaited. The fix is `ctx.waitUntil()` (the
> CF-native primitive for exactly this), **not** Effect fibers — and it is a
> real behavior change (tests may assume the sends have happened by the time
> the push returns, and a DO can hibernate after the response), so it wants
> its own change with its own test pass rather than riding in on a refactor.
> Deliberately left alone.

## ADR bookkeeping

- On Phase 1 landing: flip ADR 0015 to **Accepted**, with an amendments
  section recording corrections (a) and (b), the `Result`-as-RPC-envelope
  reframe, and the ADR 0025 reshaping of step 1. Do **not** supersede it
  (per the architecture-review-backlog note).
- Zod stays the protocol schema language (Decision C) — nothing in this
  plan touches it; the revisit triggers in the ADR stand.

## Risks

| Risk | Mitigation |
| --- | --- |
| Worker bundle blows budget | Phase 0 gate before any product code; revert target is the "tiny retry helper" alternative already recorded in the ADR |
| `@effect/sql-d1` / `sql-sqlite-do` immaturity on workerd | Phase 0 runtime proof; drivers are internal to owner modules so a revert is one module's internals |
| `runSync` fragility in the DO | Phase 3 hard-gated on the spike; declining Phase 3 is an accepted outcome |
| Two idioms during migration | Accepted by the ADR; confined by phase boundaries and the guard test |
| Paradigm creep past the port | Phase 0's guard test makes the boundary mechanical, not disciplinary |
