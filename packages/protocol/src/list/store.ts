import type { ListElement, ListGroup, ListItem, Quantity } from './index';
import type { AuthorizationRules } from '../auth/rules';
import type { InvitationIdentityKind, PendingInviteRow } from './invitations';

/**
 * The mutator-facing storage port (ADR 0014 Decision B).
 *
 * `MutatorStore` is the exact set of entity read/write operations the
 * server mutators call through `ctx.store`. It is hand-written here, in
 * the Cloudflare-free protocol package, so the mutator registry can live
 * here too; the backend's `EntityStore` (a 1:1 hoist of the
 * `SqlStorage`-bound `./sql` + invitation helpers) is a structural
 * superset and is handed in at the Durable Object call site. DO-internal
 * operations (table init, replicache client groups, the mutation log,
 * pull scans) are deliberately NOT on this surface — mutators never touch
 * them, and keeping them off `MutatorStore` keeps backend-only types
 * (e.g. `ReplicacheClientGroup`) out of protocol.
 */

/** Outcome of `setEntityMetaField`. `gone` ⇒ target row missing/deleted. */
export type SetMetaFieldOutcome = 'applied' | 'gone';

/**
 * Outcome of a field-level update.
 *  - `applied` — write landed.
 *  - `stale`   — `expected` present and didn't match; whole mutation no-op.
 *  - `gone`    — target row not found / soft-deleted.
 */
export type FieldUpdateOutcome = 'applied' | 'stale' | 'gone';

/** Writable fields on a list item (all optional; only listed keys change). */
export type ListItemWritableFields = Partial<{
    description: string;
    name: string;
    parent_element_ref: string;
    references_entity_id: string | null;
    value: Quantity;
}>;

export type ItemFieldsBatchEntry = {
    itemId: string;
    fields: ListItemWritableFields;
    expected?: ListItemWritableFields;
};

/** Writable fields on a list group (symmetric to item fields). */
export type ListGroupWritableFields = Partial<{
    description: string;
    name: string;
    parent_element_ref: string;
}>;

export type GroupFieldsBatchEntry = {
    groupId: string;
    fields: ListGroupWritableFields;
    expected?: ListGroupWritableFields;
};

export interface MutatorStore {
    // ---- create ----
    createElement(element: ListElement): void;
    insertListItem(item: ListItem): void;
    insertListGroup(group: ListGroup): void;
    appendChildElementRef(parentId: string, childId: string): void;

    // ---- narrow CAS pre-check readers ----
    getElementTypeAndSlot(
        elementId: string
    ): { type?: string; slot?: string | null } | undefined;
    getLiveEntityCasRow(entityId: string):
        | {
              type: string;
              slot: string | null;
              name: string | null;
              description: string | null;
              authorization_rules: unknown;
              workspace_id: string | null;
          }
        | undefined;
    getLiveWorkspaceCasRow(
        workspaceId: string
    ): { name: string | null; meta: unknown } | undefined;
    getLiveGroupParentRef(
        groupId: string
    ): { parent_element_ref: unknown } | undefined;
    getLiveItemCasRow(
        itemId: string
    ): { parent_element_ref: unknown; value: unknown } | undefined;

    // ---- entity-row mutations ----
    renameEntity(args: { entityId: string; name: string; version: number }): void;
    archiveEntity(args: {
        entityId: string;
        version: number;
        cascadeSource?: string | null;
    }): void;
    unarchiveEntity(args: { entityId: string; version: number }): void;
    unarchiveEntityAndClearSlot(args: {
        entityId: string;
        version: number;
    }): void;
    renameWorkspaceEntity(args: {
        workspaceId: string;
        name: string;
        version: number;
    }): void;
    bumpWorkspaceVersion(args: { workspaceId: string; version: number }): void;
    setEntityDescription(args: {
        entityId: string;
        description: string;
        version: number;
    }): void;
    setEntityAuthorizationRules(args: {
        entityId: string;
        authorization_rules: AuthorizationRules;
        version: number;
    }): void;
    setEntityWorkspaceId(args: {
        entityId: string;
        workspace_id: string;
        version: number;
    }): void;
    setEntityMetaField(args: {
        entityId: string;
        entityType: 'list' | 'template' | 'workspace';
        key: string;
        value: unknown;
        version: number;
    }): SetMetaFieldOutcome;
    setListVersion(version: number): void;

    // ---- item/group archive ----
    archiveListItem(args: { itemId: string; version: number }): void;
    unarchiveListItem(args: { itemId: string; version: number }): void;
    archiveListItems(args: {
        itemIds: readonly string[];
        version: number;
    }): void;
    unarchiveListItems(args: {
        itemIds: readonly string[];
        version: number;
    }): void;
    archiveListGroup(args: { groupId: string; version: number }): void;
    unarchiveListGroup(args: { groupId: string; version: number }): void;
    archiveListGroups(args: {
        groupIds: readonly string[];
        version: number;
    }): void;
    unarchiveListGroups(args: {
        groupIds: readonly string[];
        version: number;
    }): void;

    // ---- item/group field updates ----
    setItemValueAndVersion(args: {
        itemId: string;
        value: Quantity;
        version: number;
    }): void;
    updateListItemFields(args: {
        itemId: string;
        fields: ListItemWritableFields;
        expected?: ListItemWritableFields;
        version: number;
    }): FieldUpdateOutcome;
    updateListItemsFieldsAtomic(args: {
        entries: ItemFieldsBatchEntry[];
        version: number;
    }): FieldUpdateOutcome;
    updateListGroupFields(args: {
        groupId: string;
        fields: ListGroupWritableFields;
        expected?: ListGroupWritableFields;
        version: number;
    }): FieldUpdateOutcome;
    updateListGroupsFieldsAtomic(args: {
        entries: GroupFieldsBatchEntry[];
        version: number;
    }): FieldUpdateOutcome;
    reorderChildElement(args: {
        parentId: string;
        childId: string;
        toIndex: number;
        expectedFromIndex?: number;
        version: number;
    }): FieldUpdateOutcome;

    // ---- invitations (DO-resident pending_invites) ----
    getPendingInvite(args: {
        identity_kind: InvitationIdentityKind;
        identity_value: string;
    }): PendingInviteRow | null;
    insertPendingInvite(row: PendingInviteRow): void;
    tombstonePendingInvite(args: {
        identity_kind: InvitationIdentityKind;
        identity_value: string;
        nowSeconds: number;
        version: number;
    }): boolean;
}
