import { z } from 'zod';

import { BadMutationError } from '../../errors';
import { ListElementUnion, ListItemSchema } from '..';
import { appendChildElementRef, insertListItem } from '../sql';
import { IdTypes } from '../../id';
import { ListSchema, TemplateSchema } from '..';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

export const argsSchema = z.object({
    item: ListItemSchema,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'createListItem' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = ({ item }, { sql, nextVersion }) => {
    insertListItem(sql, { ...item, version: nextVersion });
    appendChildElementRef(sql, item.parent_element_ref, item.id);
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
