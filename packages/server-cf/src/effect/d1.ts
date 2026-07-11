import { D1Client } from '@effect/sql-d1';
import { SqlError } from '@effect/sql/SqlError';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { UnexpectedError } from '@djibb/protocol/errors';

/**
 * Effect support for the D1 owner modules (ADR 0015 / ADR 0025,
 * docs/plans/effect-adoption.md Phase 1). This is the one place the
 * `runPromise` ceremony lives: the owner modules (`derived-index/d1.ts`,
 * and `auth/d1.ts` come Phase 2) express their internals as Effect
 * programs and hand them here to run. Callers of the named operations
 * never see Effect — the exported `(db, ...) => Promise<T>` signatures
 * and the DjibbError-only failure surface are unchanged.
 *
 * Runtime topology per the Phase 0 decision: the D1Client layer is
 * built per call — no memoized `ManagedRuntime`. workerd disallows
 * cross-request promise reuse, so caching a runtime across requests
 * risks leaking scopes; revisit only if profiling shows layer-build
 * cost matters.
 */

/**
 * Bounded in-request retry for transient D1 failures inside the emit
 * operations: 2 retries with jittered exponential backoff. This is NOT
 * the reconcile backstop — the alarm-driven, DO-storage-backed retry
 * (ADR 0007) is durable state and stays exactly as is (plan correction
 * (a)); this schedule only smooths over blips within one request, and
 * is only safe on operations that are idempotent by design.
 */
export const transientD1Retry = Schedule.intersect(
    Schedule.jittered(Schedule.exponential('50 millis')),
    Schedule.recurs(2),
);

/**
 * Lift a raw D1 call into the Effect error channel. For the operations
 * the `@effect/sql-d1` driver cannot express — verified during Phase 1:
 * the driver has no D1 batch support (its transactionAcquirer dies
 * with "transactions are not supported in D1") and its `execute`
 * discards `meta`, so batch-atomic writes and `meta.changes` checks
 * stay on the raw D1 API, wrapped here so they share the error-mapping
 * and retry machinery with everything else.
 */
export const d1Try = <A>(
    attempt: () => Promise<A>,
): Effect.Effect<A, SqlError> =>
    Effect.tryPromise({
        try: attempt,
        catch: cause =>
            new SqlError({ cause, message: 'Failed to execute d1 call' }),
    });

/**
 * Run a named operation's Effect program against a D1 binding.
 *
 * Builds the D1Client layer for this call, runs the program, and maps
 * any failure (SqlError or defect) to `UnexpectedError` at this
 * boundary, so the owner module's callers keep seeing DjibbError only
 * (ADR 0025). `op` names the operation in the failure log.
 * `retry: true` opts idempotent operations into `transientD1Retry`.
 */
export function runD1<A>(
    db: D1Database,
    op: string,
    body: (sql: D1Client.D1Client) => Effect.Effect<A, SqlError>,
    options?: { readonly retry?: boolean },
): Promise<A> {
    const attempt = Effect.flatMap(D1Client.D1Client, body);
    const program = options?.retry
        ? Effect.retry(attempt, transientD1Retry)
        : attempt;
    return Effect.runPromise(
        program.pipe(Effect.provide(D1Client.layer({ db })), Effect.scoped),
    ).catch(cause => {
        console.error(`${op} failed:`, cause);
        throw new UnexpectedError();
    });
}
