# ADR 0025: D1 storage discipline — two owner modules, no port

- **Status:** Accepted
- **Date:** 2026-07-06
- **Layer:** server-cf

## Context

DO-internal SQLite has a deep storage module (`list/sql.ts`); D1 does not. At the time of this decision, 54 `prepare()` calls sat inline across 12 files — table names and join predicates duplicated at every call site, with `entity_memberships` written from both the invitation-accept path and the workspace service. An architecture review flagged this as the widest open seam in the codebase: a D1 schema change touches ten files, and the atomicity invariants (which statements must land in one `batch()`) live in each caller's head.

The D1 tables split into two families with different authority models: the **Derived Index** (`workspace_entities`, `entity_memberships`, `entity_invitations_index`) where D1 is a regenerable projection of DO state (ADR 0003, swept by ADR 0007), and the **auth substrate** (`accounts`, `sessions`, `magic_link_tokens`, `issued_credentials`, `usernames`) where D1 is authoritative.

## Decision

**All D1 SQL lives in exactly two owner modules; every other file calls named operations on them.**

> **Correction (2026-07-06, during implementation):** the plan below
> named a third module, `account/d1.ts`, owning a `usernames` table.
> No such table exists — usernames are a column on `accounts` — so the
> auth substrate owns them and the third module was never created.
> `account/username.ts` keeps the format/reserved-word policy and calls
> `auth/d1.ts` for the substrate reads/writes.

- `derived-index/d1.ts` — owns the Derived Index family. Ownership follows the lifecycle (born from DO snapshot emits, swept together), not the reading context: catalog, workspace service, role resolver, and the DO's emit paths all call in.
- `auth/d1.ts` — owns the auth substrate (accounts, sessions, magic-link tokens, issued credentials).

**One module owns each table's writes.** A context that needs another family's table calls the owning module (e.g. `account/service.ts` calls `auth/d1.ts::CreateAccount`), never inlines the SQL.

**Shape mirrors `sql.ts`:** free functions with `db: D1Database` as the first parameter, named after the operation.

**Compound operations batch internally.** Multi-statement invariants (invitation accept = membership insert + invitations-index update) are single named operations that call `db.batch()` inside; callers never see `D1PreparedStatement`. **A batch never crosses module ownership** — D1 cannot transact across `batch()` calls, so an apparent need for cross-family atomicity signals a misdesigned flow (or that ADR 0007 reconciliation is the right consistency tool, as it already is for DO→D1).

**Domain-typed returns, zod at the seam, DjibbError-only failures.** Functions return row types declared by the d1 module (never `D1Result`, never raw records; these types stay in server-cf, not `@djibb/protocol`). Rows are zod-parsed on read — Derived Index rows in particular may have been emitted by an older deploy, and the parse turns silent shape-drift into a loud error at the one module that owns the table.

**No port interface.** `server-cf` *is* the Cloudflare adapter (ADR 0014's portable seam sits above it, at `MutatorStore`), and tests exercise these modules against real D1 via miniflare — so there is never a second adapter, and one adapter is a hypothetical seam. If ADR 0015 (Effect) ever activates, the vendored `repos/effect/packages/sql-d1` and `sql-sqlite-do` are the designated implementations — an internal swap behind the same named operations, invisible to callers.

**Enforcement is a vitest guard test with a shrink-only allowlist.** The test fails if `.prepare(`/`.batch(` appears outside the three modules, and fails if the allowlist names a file that has come clean — the offender list can only ratchet toward zero. Landed before the first migration commit.

## Considered options

- **One flat `d1.ts` mirroring `sql.ts`:** rejected — would start at ~1,500 LOC and recreate the problem `sql.ts`'s own TODO ("split this file by model") complains about. The seam is the naming convention plus the guard test, not one physical file.
- **Splitting the Derived Index by reading context** (workspace owns memberships, etc.): rejected — re-splits the "one writer, one lifecycle" fact across readers, which is how the original scatter happened.
- **Statement-returning helpers composed by callers:** rejected — puts `D1PreparedStatement` in the interface and moves atomicity invariants back to call sites.
- **A port interface now, as Effect prep:** rejected — layering for a hypothetical adapter. The Effect-ready properties are already structural: `db` as first argument lifts into a service; named `DjibbError` classes map onto tagged failures.

## Consequences

- Migration order: `derived-index/d1.ts` first (heaviest scatter; unblocks role-resolution and DO-decomposition work), then `auth/d1.ts`, then `account/d1.ts`. Behavior-preserving, file-by-file, with existing workers tests as the regression net.
- New direct tests only for operations carrying an invariant (accept atomicity, snapshot-emit idempotency), exercised through the module interface against miniflare D1.
- `derived-index/d1.ts` gives the ADR 0003 concept a module; the term is now in `packages/server-cf/CONTEXT.md`.
