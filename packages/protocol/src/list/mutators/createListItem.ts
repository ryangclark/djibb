import { z } from 'zod';

import { AppendLimitError, BadMutationError } from '@djibb/protocol/errors';
import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import { ListElementUnion, ListItemSchema } from '@djibb/protocol/list';
import { IdTypes } from '@djibb/protocol/id';
import { ListSchema, TemplateSchema } from '@djibb/protocol/list';
import { APPEND_ROLES, SUBMITTER_APPEND_CEILING, toStoredValue } from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

export const argsSchema = z.object({
    item: ListItemSchema,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'createListItem' as const;
// Append is the one mutation widened to `submitter` (ADR 0021): an
// append-only list (`default_role: 'submitter'`) admits new items while
// every other mutator stays gated on `EDIT_ROLES`.
export const requiredRole = APPEND_ROLES;

export const server: ServerMutator<Args> = ({ item }, { store, role, nextVersion }) => {
    // Structural append-volume cap (ADR 0021 / GH #66). `submitter` is the
    // one append-only role widened into this mutator's gate, and the only
    // role a token-less anonymous stranger resolves to on a `default_role:
    // 'submitter'` entity. Bound its total live-item volume here — where the
    // write actually lands — so the cap holds regardless of how Replicache
    // packs mutations into a `/push` (the per-request rate limit from
    // #14/#40 can't see per-item volume). EDIT_ROLES (owner/editor/…) skip
    // this: they own the list and curate it. Permanent for this push: throw
    // an `AppendLimitError`, which the DO maps to a `precondition` outcome +
    // skip-and-ack (see `handleMutation`), so the optimistic add rolls back
    // with a reason and Replicache's pusher never wedges.
    if (
        role === AuthorizationRoleEnum.enum.submitter &&
        store.atOrOverLiveItemLimit(SUBMITTER_APPEND_CEILING)
    ) {
        throw new AppendLimitError(
            `append limit reached: this list is capped at ${SUBMITTER_APPEND_CEILING} items for open submissions`
        );
    }
    store.insertListItem({ ...item, version: nextVersion });
    store.appendChildElementRef(item.parent_element_ref, item.id);
};

export const client: ClientMutator<Args> = async (tx, { item }) => {
    if (!item.parent_element_ref) {
        throw new BadMutationError('invalid `parent_element_ref`');
    }

    const rawParent = await tx.get(item.parent_element_ref);
    if (!rawParent) {
        throw new BadMutationError('parent element not found');
    }

    const parentParse = ListElementUnion.safeParse(rawParent);
    if (!parentParse.success) {
        console.error(
            '`createListItem()` parse error of raw element:',
            z.prettifyError(parentParse.error)
        );
        throw new BadMutationError('invalid element');
    }
    const parentElement = parentParse.data;

    if (
        parentElement.type !== 'list' &&
        parentElement.type !== 'template' &&
        parentElement.type !== 'group'
    ) {
        throw new BadMutationError('unexpected `parentElement.type`');
    }
    parentElement.child_element_refs.push(item.id);

    await Promise.all([
        tx.set(parentElement.id, toStoredValue(parentElement)),
        tx.set(item.id, toStoredValue(item)),
        incrementListVersion(tx),
    ]);
};

async function incrementListVersion(tx: Parameters<ClientMutator<Args>>[0]) {
    // Either a list or a template owns this item; check both prefixes so
    // the optimistic client write works on either entity type.
    const entityElement =
        (await scanFirst(tx, `${IdTypes['list']}/`, ListSchema)) ??
        (await scanFirst(tx, `${IdTypes['template']}/`, TemplateSchema));
    if (!entityElement) throw new BadMutationError('entity element not found');
    entityElement.version += 1;
    return tx.set(entityElement.id, toStoredValue(entityElement));
}

/**
 * Constructive inverse: archive the just-created item. The id is
 * already in `args.item`, so no `capturePreState` is needed.
 */
export const inverse: Inverse<Args> = ({ item }) => ({
    name: 'archiveListItem',
    args: { id: item.id },
});

async function scanFirst<T>(
    tx: Parameters<ClientMutator<Args>>[0],
    prefix: string,
    schema: { safeParse: (x: unknown) => { success: boolean; data?: T } },
): Promise<T | undefined> {
    const scanResult = tx.scan({ prefix, limit: 1 });
    for await (const result of scanResult) {
        const parsed = schema.safeParse(result);
        if (parsed.success) return parsed.data;
    }
    return undefined;
}
