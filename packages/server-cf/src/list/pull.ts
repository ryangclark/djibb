import type { PatchOperation } from 'replicache';

import { OWNER_ROLES } from '@djibb/protocol/list/mutators/_shared';
import {
    getChangedInvitesSinceVersion,
    listAllCurrentInviteKeys,
    type PendingInviteRow,
} from './invitations';
import type { Keyspace } from '../replicache/keyspaces';

/**
 * Keyspaces for `DjibbList` pulls (ADR 0009 §"PII gating via pull
 * filter"). Each entry declares a Replicache key prefix, a role
 * predicate, and the reader functions that bridge the prefix to its
 * source table in the DO sql.
 *
 * The main `list_elements`-based pull (entity, items, groups) is NOT
 * a keyspace here — it's the default surface every non-restricted
 * role sees, and predates this generalization. Future cleanup could
 * fold it in as a keyspace with `visibleTo: role => role !== 'restricted'`,
 * but the existing handler already correctly emits it; not worth
 * the churn for Slice 2.
 *
 * There is no separate workspace DO class (ADR 0026: one `DjibbList`
 * class, decomposed internally). Workspaces are `w/`-prefixed entities
 * on the same DO, so any workspace-specific pull surface would extend
 * this same array rather than live behind a sibling class.
 */
export const LIST_PULL_KEYSPACES: readonly Keyspace[] = [
    {
        name: 'pending_invites',
        keyPrefix: 'pending_invites',
        visibleTo: role => OWNER_ROLES.includes(role),
        readChanges(sql, prevVersion) {
            const rows = getChangedInvitesSinceVersion(sql, prevVersion);
            return rows.map(rowToPatch);
        },
        listAllCurrentKeys(sql) {
            return listAllCurrentInviteKeys(sql);
        },
    },
];

function rowToPatch(row: PendingInviteRow): PatchOperation {
    const key = `pending_invites/${row.identity_value}`;
    if (row.time_deleted != null) {
        return { op: 'del', key };
    }
    return {
        op: 'put',
        key,
        value: {
            identity_kind: row.identity_kind,
            identity_value: row.identity_value,
            role: row.role,
            inviter_account_id: row.inviter_account_id,
            time_created: row.time_created,
            time_expires: row.time_expires,
            version: row.version,
        },
    };
}
