import * as sql from './sql';
import * as invitations from './invitations';
/**
 * The `EntityStore` port (ADR 0014 Decision B).
 *
 * A 1:1 hoist of the `SqlStorage`-backed helpers in `./sql` into a
 * storage-bound object. Server mutators depend on this narrow interface
 * (`ctx.store`) instead of importing `SqlStorage` functions and threading
 * `ctx.sql` into them — which is what lets the mutator registry, and
 * eventually this interface, move to a Cloudflare-free package. The
 * adapter below is the only thing that knows about `SqlStorage`; the
 * interface shape itself is storage-agnostic.
 *
 * Derived, not hand-written: `EntityStore` is the `./sql` value namespace
 * (its 40 functions; `export type`s aren't values, so they don't appear)
 * with each function's leading `sql: SqlStorage` parameter dropped. Add a
 * function to `./sql` and it shows up here automatically.
 *
 * Migration is incremental: `ctx.sql` and `ctx.store` coexist on
 * `ServerMutatorCtx`. Mutators that still issue raw `sql.exec(...)`
 * (e.g. set-family CAS pre-checks) keep using `ctx.sql` until those
 * queries grow their own store methods; helper calls move to `ctx.store`.
 */
type DropSqlArg<F> = F extends (sql: SqlStorage, ...rest: infer R) => infer Ret ? (...rest: R) => Ret : never;
/**
 * The DO-resident `pending_invites` helpers from `./invitations` (ADR
 * 0009) are part of the same `SqlStorage` boundary as `./sql`, so they
 * join the port. Only the three single-row helpers the invitation
 * mutators call are surfaced — the table DDL, D1 projection, and
 * reconciler stay backend-internal.
 */
type InvitationPortFns = Pick<typeof invitations, 'getPendingInvite' | 'insertPendingInvite' | 'tombstonePendingInvite'>;
export type EntityStore = {
    [K in keyof typeof sql]: DropSqlArg<(typeof sql)[K]>;
} & {
    [K in keyof InvitationPortFns]: DropSqlArg<InvitationPortFns[K]>;
};
/**
 * Cloudflare adapter: bind every `./sql` helper to a fixed `SqlStorage`
 * handle, producing the `EntityStore` the runtime hands to mutators.
 */
export declare function createSqlStorageEntityStore(storage: SqlStorage): EntityStore;
export {};
