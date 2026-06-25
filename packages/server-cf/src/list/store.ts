import type { MutatorStore } from '@djibb/protocol/list/store';

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

type DropSqlArg<F> = F extends (sql: SqlStorage, ...rest: infer R) => infer Ret
    ? (...rest: R) => Ret
    : never;

/**
 * The DO-resident `pending_invites` helpers from `./invitations` (ADR
 * 0009) are part of the same `SqlStorage` boundary as `./sql`, so they
 * join the port. Only the three single-row helpers the invitation
 * mutators call are surfaced — the table DDL, D1 projection, and
 * reconciler stay backend-internal.
 */
type InvitationPortFns = Pick<
    typeof invitations,
    'getPendingInvite' | 'insertPendingInvite' | 'tombstonePendingInvite'
>;

export type EntityStore = {
    [K in keyof typeof sql]: DropSqlArg<(typeof sql)[K]>;
} & {
    [K in keyof InvitationPortFns]: DropSqlArg<InvitationPortFns[K]>;
};

/**
 * Compile-time guard for ADR 0014's "EntityStore is a structural superset
 * of MutatorStore" invariant. The runtime relies on it (mutators receive
 * `ctx.store: MutatorStore` but are handed the full `EntityStore`); this
 * assignment makes the relationship a build error if it ever breaks —
 * e.g. a `MutatorStore` method whose signature no `./sql` helper backs —
 * rather than depending on the incidental check at the DO call site.
 */
type _EntityStoreSatisfiesMutatorStore = EntityStore extends MutatorStore
    ? true
    : never;
const _entityStoreSatisfiesMutatorStore: _EntityStoreSatisfiesMutatorStore = true;
void _entityStoreSatisfiesMutatorStore;

/**
 * Cloudflare adapter: bind every `./sql` helper to a fixed `SqlStorage`
 * handle, producing the `EntityStore` the runtime hands to mutators.
 */
export function createSqlStorageEntityStore(storage: SqlStorage): EntityStore {
    const bind =
        <A extends unknown[], R>(fn: (sql: SqlStorage, ...args: A) => R) =>
        (...args: A): R =>
            fn(storage, ...args);

    return {
        createElement: bind(sql.createElement),
        getElementById: bind(sql.getElementById),
        getElementTypeAndSlot: bind(sql.getElementTypeAndSlot),
        getLiveEntityCasRow: bind(sql.getLiveEntityCasRow),
        getLiveWorkspaceCasRow: bind(sql.getLiveWorkspaceCasRow),
        getLiveGroupParentRef: bind(sql.getLiveGroupParentRef),
        getLiveItemCasRow: bind(sql.getLiveItemCasRow),
        getChangedElements: bind(sql.getChangedElements),
        InitializeTables: bind(sql.InitializeTables),
        getEntityId: bind(sql.getEntityId),
        getListVersion: bind(sql.getListVersion),
        setListVersion: bind(sql.setListVersion),
        getReplicacheClientGroupById: bind(sql.getReplicacheClientGroupById),
        renameEntity: bind(sql.renameEntity),
        archiveEntity: bind(sql.archiveEntity),
        unarchiveEntity: bind(sql.unarchiveEntity),
        unarchiveEntityAndClearSlot: bind(sql.unarchiveEntityAndClearSlot),
        archiveListItem: bind(sql.archiveListItem),
        unarchiveListItem: bind(sql.unarchiveListItem),
        archiveListItems: bind(sql.archiveListItems),
        unarchiveListItems: bind(sql.unarchiveListItems),
        archiveListGroup: bind(sql.archiveListGroup),
        unarchiveListGroup: bind(sql.unarchiveListGroup),
        archiveListGroups: bind(sql.archiveListGroups),
        unarchiveListGroups: bind(sql.unarchiveListGroups),
        setEntityMetaField: bind(sql.setEntityMetaField),
        renameWorkspaceEntity: bind(sql.renameWorkspaceEntity),
        bumpWorkspaceVersion: bind(sql.bumpWorkspaceVersion),
        setEntityDescription: bind(sql.setEntityDescription),
        setEntityAuthorizationRules: bind(sql.setEntityAuthorizationRules),
        setEntityWorkspaceId: bind(sql.setEntityWorkspaceId),
        setItemValueAndVersion: bind(sql.setItemValueAndVersion),
        updateListItemFields: bind(sql.updateListItemFields),
        updateListItemsFieldsAtomic: bind(sql.updateListItemsFieldsAtomic),
        updateListGroupFields: bind(sql.updateListGroupFields),
        updateListGroupsFieldsAtomic: bind(sql.updateListGroupsFieldsAtomic),
        insertListItem: bind(sql.insertListItem),
        insertListGroup: bind(sql.insertListGroup),
        appendChildElementRef: bind(sql.appendChildElementRef),
        reorderChildElement: bind(sql.reorderChildElement),
        setElementAsDeleted: bind(sql.setElementAsDeleted),
        setMutation: bind(sql.setMutation),
        ensureMutationsCredentialColumn: bind(sql.ensureMutationsCredentialColumn),
        getMutationLog: bind(sql.getMutationLog),
        setListItemValue: bind(sql.setListItemValue),
        setReplicacheClientGroup: bind(sql.setReplicacheClientGroup),
        getPendingInvite: bind(invitations.getPendingInvite),
        insertPendingInvite: bind(invitations.insertPendingInvite),
        tombstonePendingInvite: bind(invitations.tombstonePendingInvite),
    };
}
