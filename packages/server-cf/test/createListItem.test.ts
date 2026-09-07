import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList, asLocalList } from '../src/list/durable_object';
import { IdTypes, newId } from '@djibb/protocol/id';
import type { ListItem, Quantity } from '@djibb/protocol/list';
import { SUBMITTER_APPEND_CEILING } from '@djibb/protocol/list/mutators/_shared';

// End-to-end coverage for the "append item" path:
//   initList push → createListItem push → verify SQL + pull patch.
// Mirrors the setItemQuantity test style.

function getListStub(name: string) {
    const prefixed = `${IdTypes.list}/${name.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makeInitListPush({
    clientGroupID,
    clientID,
    listId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                },
            },
        ],
    };
}

function makeItem(
    listId: string,
    name: string,
    overrides: Partial<ListItem> = {}
): ListItem {
    const now = new Date();
    return {
        id: newId('item'),
        name,
        parent_element_ref: listId,
        references_entity_id: null,
        time_created: now,
        time_deleted: null,
        time_updated: now,
        type: 'item',
        value: { target_value: 1, value: 0, unit: 'bool' },
        version: 0,
        ...overrides,
    };
}

function makeCreateListItemPush({
    clientGroupID,
    clientID,
    item,
    mutationId,
}: {
    clientGroupID: string;
    clientID: string;
    item: ListItem;
    mutationId: number;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: mutationId,
                name: 'createListItem',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: item.time_created.toISOString(),
                    item: {
                        ...item,
                        time_created: item.time_created.toISOString(),
                        time_deleted: null,
                        time_updated: item.time_updated.toISOString(),
                    },
                },
            },
        ],
    };
}

function makeSetItemQuantityPush({
    clientGroupID,
    clientID,
    itemId,
    mutationId,
    quantity,
}: {
    clientGroupID: string;
    clientID: string;
    itemId: string;
    mutationId: number;
    quantity: Quantity;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: mutationId,
                name: 'setItemQuantity',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    itemId,
                    quantity,
                },
            },
        ],
    };
}

describe('createListItem end-to-end', () => {
    it('inserts the item, appends to list.child_element_refs, bumps list version', async () => {
        const { listId, stub } = getListStub('create1');
        const clientGroupID = 'cg_create_1';
        const clientID = 'c_create_1';

        const initResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });
        expect(initResult.error).toBeNull();

        const item = makeItem(listId, 'First item');

        const createResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });
        expect(createResult.error).toBeNull();

        const snapshot = await runInDurableObject(stub, async (_i, state) => {
            const itemRow = state.storage.sql
                .exec(
                    `SELECT name, type, value, version
                     FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one();
            const listRow = state.storage.sql
                .exec(
                    `SELECT child_element_refs, version
                     FROM list_elements WHERE type = 'list' LIMIT 1;`
                )
                .one();
            return {
                itemRow,
                listRow,
            };
        });

        expect(snapshot.itemRow.name).toBe('First item');
        expect(snapshot.itemRow.type).toBe('item');
        expect(snapshot.itemRow.version).toBe(2);
        expect(JSON.parse(snapshot.itemRow.value as string)).toEqual(
            item.value
        );

        expect(snapshot.listRow.version).toBe(2);
        expect(
            JSON.parse(snapshot.listRow.child_element_refs as string)
        ).toEqual([item.id]);

        const pullResult = await asLocalList(stub).handlePull({
            authorizedRole: 'ownerless',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(pullResult.error).toBeNull();
        const pullData = pullResult.data!;
        // Cookie shape (ADR 0009): `{v, r}` — entity version + role
        // at last pull. The `r` powers the keyspaces pull-filter
        // demotion path.
        expect(pullData.cookie).toMatchObject({ v: 2 });

        const itemPatch = pullData.patch.find(
            entry => entry.op === 'put' && entry.key === item.id
        );
        expect(itemPatch).toBeDefined();
        if (itemPatch?.op === 'put') {
            expect(itemPatch.value).toMatchObject({
                id: item.id,
                type: 'item',
                version: 2,
                name: 'First item',
            });
        }
    });

    it('rejects createListItem for restricted role', async () => {
        const { listId, stub } = getListStub('create2');
        const clientGroupID = 'cg_create_2';
        const clientID = 'c_create_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });

        const item = makeItem(listId, 'Forbidden item');

        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });

        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);
    });

    it('round-trips a non-null references_entity_id (Seed Pool style)', async () => {
        const { listId, stub } = getListStub('create3');
        const clientGroupID = 'cg_create_3';
        const clientID = 'c_create_3';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });

        const blankId = newId('template');
        const item = makeItem(listId, 'Pointer to a Blank', {
            references_entity_id: blankId,
        });

        const createResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });
        expect(createResult.error).toBeNull();

        const stored = await runInDurableObject(stub, async (_i, state) => {
            return state.storage.sql
                .exec(
                    `SELECT references_entity_id
                     FROM list_elements WHERE id = ?;`,
                    item.id
                )
                .one();
        });
        expect(stored.references_entity_id).toBe(blankId);

        const pullResult = await asLocalList(stub).handlePull({
            authorizedRole: 'ownerless',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(pullResult.error).toBeNull();
        const itemPatch = pullResult.data!.patch.find(
            entry => entry.op === 'put' && entry.key === item.id
        );
        expect(itemPatch).toBeDefined();
        if (itemPatch?.op === 'put') {
            expect(itemPatch.value).toMatchObject({
                id: item.id,
                references_entity_id: blankId,
            });
        }
    });
});

describe('full browser journey: create + toggle multiple items', () => {
    it('initList → createListItem ×2 → toggle both → pull reflects final state', async () => {
        const { listId, stub } = getListStub('journey');
        const clientGroupID = 'cg_journey';
        const clientID = 'c_journey';

        // 1. init
        const initResult = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
            }),
        });
        expect(initResult.error).toBeNull();

        // 2. create two items
        const itemA = makeItem(listId, 'A');
        const itemB = makeItem(listId, 'B');

        const createA = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item: itemA,
                mutationId: 2,
            }),
        });
        expect(createA.error).toBeNull();

        const createB = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item: itemB,
                mutationId: 3,
            }),
        });
        expect(createB.error).toBeNull();

        // 3. toggle both checked
        const checked: Quantity = {
            target_value: 1,
            value: 1,
            unit: 'bool',
        };
        const toggleA = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemQuantityPush({
                clientGroupID,
                clientID,
                itemId: itemA.id,
                mutationId: 4,
                quantity: checked,
            }),
        });
        expect(toggleA.error).toBeNull();

        const toggleB = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeSetItemQuantityPush({
                clientGroupID,
                clientID,
                itemId: itemB.id,
                mutationId: 5,
                quantity: checked,
            }),
        });
        expect(toggleB.error).toBeNull();

        // 4. pull from scratch: list row + both items should be in the patch
        const pullResult = await asLocalList(stub).handlePull({
            authorizedRole: 'ownerless',
            listId,
            pullRequest: {
                pullVersion: 1,
                profileID: 'p_test',
                clientGroupID,
                cookie: null,
                schemaVersion: '1',
            },
        });
        expect(pullResult.error).toBeNull();
        const pullData = pullResult.data!;
        // init(1) + create(2) + create(3) + toggle(4) + toggle(5) = v=5
        expect(pullData.cookie).toMatchObject({ v: 5 });

        const byKey = new Map(
            pullData.patch
                .filter(p => p.op === 'put')
                .map(p => [(p as { key: string }).key, p])
        );
        expect(byKey.has(itemA.id)).toBe(true);
        expect(byKey.has(itemB.id)).toBe(true);

        const patchA = byKey.get(itemA.id);
        const patchB = byKey.get(itemB.id);
        if (patchA?.op === 'put') {
            expect(patchA.value).toMatchObject({
                id: itemA.id,
                type: 'item',
                value: checked,
            });
        }
        if (patchB?.op === 'put') {
            expect(patchB.value).toMatchObject({
                id: itemB.id,
                type: 'item',
                value: checked,
            });
        }

        // The list row should carry both child refs in order.
        const listPatch = Array.from(byKey.values()).find(
            p => p.op === 'put' && (p.value as { type?: string })?.type === 'list'
        );
        expect(listPatch).toBeDefined();
        if (listPatch?.op === 'put') {
            expect(
                (listPatch.value as { child_element_refs: string[] })
                    .child_element_refs
            ).toEqual([itemA.id, itemB.id]);
        }
    });
});

/**
 * Structural append-volume cap (ADR 0021 / GH #66). The Workers rate limit
 * from #14/#40 (PR #65) counts a `/push` as one hit, but Replicache batches
 * N appends into one `/push` — so a token-less `submitter` can still balloon
 * a `default_role: 'submitter'` entity (the Contributed List). The cap lives
 * in the `createListItem` mutator, keyed on live-item count, and refuses over
 * the ceiling via skip-and-ack so Replicache's pusher never wedges.
 *
 * Seeding straight to the ceiling with raw item rows is far cheaper than
 * pushing thousands of mutations, and the cap reads live rows regardless of
 * how they got there.
 */
function seedItemsToCeiling(
    stub: DurableObjectStub<DjibbList>,
    count: number
): Promise<void> {
    return runInDurableObject(stub, async (_i, state) => {
        for (let n = 0; n < count; n++) {
            state.storage.sql.exec(
                `INSERT INTO list_elements (id, name, type, version)
                 VALUES (?, 'seed', 'item', 1);`,
                `${IdTypes.item}/seed${n.toString().padStart(10, '0')}`
            );
        }
    });
}

function countLiveItems(stub: DurableObjectStub<DjibbList>): Promise<number> {
    return runInDurableObject(stub, async (_i, state) => {
        const row = state.storage.sql
            .exec(
                `SELECT COUNT(*) AS n FROM list_elements
                 WHERE type = 'item' AND time_deleted IS NULL;`
            )
            .one() as { n: number };
        return row.n;
    });
}

describe('createListItem structural append cap (submitter, GH #66)', () => {
    it('skip-and-acks a submitter append once the entity hits the ceiling', async () => {
        const { listId, stub } = getListStub('cap1');
        const clientGroupID = 'cg_cap_1';
        const clientID = 'c_cap_1';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        await seedItemsToCeiling(stub, SUBMITTER_APPEND_CEILING);

        const overCap = makeItem(listId, 'one too many');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'submitter',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item: overCap,
                mutationId: 2,
            }),
        });

        // Skip-and-ack: the push as a whole succeeds (no wedge / no 4xx),
        // but the over-cap item was never written and the live count stays
        // pinned at the ceiling.
        expect(result.error).toBeNull();

        const present = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT id FROM list_elements WHERE id = ?;`, overCap.id)
                .toArray()
        );
        expect(present).toHaveLength(0);
        expect(await countLiveItems(stub)).toBe(SUBMITTER_APPEND_CEILING);

        // ...and it writes NO mutation-log row. The log serializes the full
        // args, and nothing prunes that table — logging refusals would leave
        // the very storage-growth vector this cap closes (one full-payload
        // row per over-cap attempt, forever).
        const logged = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(
                    `SELECT id FROM mutations WHERE name = 'createListItem';`
                )
                .toArray()
        );
        expect(logged).toHaveLength(0);
    });

    it('still admits an EDIT-role append at the ceiling — owners are uncapped', async () => {
        const { listId, stub } = getListStub('cap2');
        const clientGroupID = 'cg_cap_2';
        const clientID = 'c_cap_2';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        await seedItemsToCeiling(stub, SUBMITTER_APPEND_CEILING);

        const item = makeItem(listId, 'owner still adds');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            // `ownerless` is an EDIT role (an anonymous-edit list's owner-
            // equivalent); the cap is submitter-only, so this must land.
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });
        expect(result.error).toBeNull();

        const present = await runInDurableObject(stub, async (_i, state) =>
            state.storage.sql
                .exec(`SELECT id FROM list_elements WHERE id = ?;`, item.id)
                .toArray()
        );
        expect(present).toHaveLength(1);
        expect(await countLiveItems(stub)).toBe(SUBMITTER_APPEND_CEILING + 1);
    });

    it('admits a submitter append below the ceiling', async () => {
        const { listId, stub } = getListStub('cap3');
        const clientGroupID = 'cg_cap_3';
        const clientID = 'c_cap_3';

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({ clientGroupID, clientID, listId }),
        });

        const item = makeItem(listId, 'a normal contribution');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'submitter',
            listId,
            pushRequest: makeCreateListItemPush({
                clientGroupID,
                clientID,
                item,
                mutationId: 2,
            }),
        });
        expect(result.error).toBeNull();
        expect(await countLiveItems(stub)).toBe(1);
    });
});
