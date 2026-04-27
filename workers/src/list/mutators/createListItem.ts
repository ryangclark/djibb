import { z } from 'zod';

import { BadMutationError } from '../../errors';
import { ListElementUnion, ListItemSchema } from '..';
import { appendChildElementRef, insertListItem } from '../sql';
import { IdTypes } from '../../id';
import { ListSchema } from '..';
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

    if (parentElement.type !== 'list' && parentElement.type !== 'group') {
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
    const scanResult = tx.scan({ prefix: `${IdTypes['list']}/`, limit: 1 });
    let listElement;
    for await (const result of scanResult) {
        const parseResult = ListSchema.safeParse(result);
        if (parseResult.success) {
            listElement = parseResult.data;
            break;
        }
    }
    if (!listElement) throw new BadMutationError('list element not found');
    listElement.version += 1;
    return tx.set(listElement.id, toStoredValue(listElement));
}
