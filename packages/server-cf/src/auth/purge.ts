/**
 * Account-deletion Phase 2 (GH #64) — the entity relinquish cascade.
 *
 * When the purge sweep (`d1.ts` `PurgeTombstonedAccounts`) hard-purges a
 * tombstoned account past its grace window, the account must be removed
 * from every shared List/Template it belongs to before it's scrubbed:
 * an entity it *owns* has ownership handed off (force-transferred to the
 * most-senior remaining member, or orphaned to `ownerless` when none
 * remains), and any other membership is simply dropped — so the scrubbed
 * identity is never left dangling in an entity's `authorization_rules`.
 *
 * The disposition itself is a DO mutator (`relinquishOwnershipOnPurge`,
 * `@djibb/protocol`); this module is only the worker→DO *driver*. It
 * mirrors the workspace cascade (`workspace/cascade.ts`
 * `cascadeArchiveChild`): a synthetic-client push with `authorizedRole:
 * 'system'` (the only way to satisfy the mutator's `SYSTEM_ROLES` gate)
 * so the `_handlePush` path runs the mutation, reprojects
 * `entity_memberships` into D1, and fires the transfer-notification email
 * — all for free.
 *
 * The push writer's `clientGroupID` is `cg_purge:<accountId>`, one of the
 * reserved single-writer prefixes that the Replicache client GC never
 * reaps (`list/sql.ts` GC_RESERVED_CLIENT_GROUP_PREFIXES, GH #35), and
 * the `clientID` is deterministic per (account, entity) so a retry after
 * a partial failure reuses the same bookkeeping row instead of minting a
 * fresh one every night.
 */
import { ListMemberEntityIdsForAccount } from '../derived-index/d1';
import { UnexpectedError } from '@djibb/protocol/errors';
import type { DjibbList } from '../list/durable_object';

export interface RelinquishDeps {
    d1: D1Database; // env.DJIBB_AUTH — the entity_memberships projection
    listNs: DurableObjectNamespace; // env.DJIBB_LIST — the member entity DOs
    accountId: string;
}

/**
 * Relinquish the account from every List/Template it belongs to. Throws
 * if any single relinquish push fails to apply (a rejected RPC or a
 * non-null result error — an infrastructure/DjibbError failure, not a
 * benign `gone` no-op) so the caller leaves the account un-purged and the
 * next sweep tick retries. Returns the number of entities the cascade
 * drove a relinquish into.
 */
export async function relinquishAccountFromEntities(
    deps: RelinquishDeps,
): Promise<{ relinquished: number }> {
    const { d1, listNs, accountId } = deps;

    const memberEntityIds = await ListMemberEntityIdsForAccount(d1, accountId);
    for (const entityId of memberEntityIds) {
        await relinquishOne(listNs, accountId, entityId);
    }
    return { relinquished: memberEntityIds.length };
}

async function relinquishOne(
    listNs: DurableObjectNamespace,
    accountId: string,
    entityId: string,
): Promise<void> {
    const stubId = listNs.idFromName(entityId);
    const stub = listNs.get(stubId) as unknown as DurableObjectStub<DjibbList>;

    const result = await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'system',
        listId: entityId,
        pushRequest: {
            profileID: 'p_purge',
            clientGroupID: `cg_purge:${accountId}`,
            pushVersion: 1,
            schemaVersion: '1',
            mutations: [
                {
                    // Deterministic per (account, entity): a retry reuses
                    // this clientID + mutation id, so the DO acks the
                    // duplicate instead of re-running, and the reserved
                    // `cg_purge:` client row never multiplies.
                    clientID: `purge:${accountId}:${entityId}`,
                    id: 1,
                    name: 'relinquishOwnershipOnPurge',
                    timestamp: Date.now(),
                    args: {
                        accountId: null,
                        timestamp_client: new Date().toISOString(),
                        listId: entityId,
                        departingAccountId: accountId,
                    },
                },
            ],
        },
    });

    // `handlePush` returns a Result rather than throwing on a transport /
    // DjibbError failure. Surface it as a throw so the sweep leaves the
    // account un-purged (retry next tick) instead of counting a failed
    // relinquish as done and scrubbing the still-dangling owner. A benign
    // `gone` (entity truly absent) does not set `error`.
    if (result.error) {
        throw new UnexpectedError(
            `relinquishOwnershipOnPurge failed for entity "${entityId}"`,
        );
    }
}
