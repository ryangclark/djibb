import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '@djibb/protocol/id';
import { MAX_DEPTH } from '@djibb/protocol/list/markdown';

// Write-side enforcement of the group-nesting ceiling (ADR 0012 §G). The
// Markdown importer clamps depth, but a raw `initList` push doesn't — so the
// mutator itself must reject a tree deeper than MAX_DEPTH (or a cycle). We
// assert on *state*: a rejected mutation is skip-and-acked (push succeeds, the
// guard throws before any write), so nothing lands in the DO.

function getListStub(name: string) {
    const prefixed = `${IdTypes.list}/${name.padEnd(21, 'a').slice(0, 21)}`;
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(
            env.DJIBB_LIST.idFromName(prefixed)
        ) as DurableObjectStub<DjibbList>,
    };
}

/** A well-formed group row (passes Zod) so only the depth guard can reject. */
function makeGroup(id: string, parentRef: string, childRefs: string[]) {
    const now = new Date().toISOString();
    return {
        id,
        name: 'g',
        parent_element_ref: parentRef,
        child_element_refs: childRefs,
        type: 'group' as const,
        version: 0,
        time_created: now,
        time_updated: now,
        time_deleted: null,
    };
}

/** initList push whose groups form a straight chain `levels` deep. */
function makeDeepInitPush(listId: string, levels: number): PushRequestV1 {
    const ids = Array.from({ length: levels }, () => newId('group'));
    const groups = ids.map((id, i) =>
        makeGroup(id, i === 0 ? listId : ids[i - 1]!, i < levels - 1 ? [ids[i + 1]!] : [])
    );
    return {
        profileID: 'p_test',
        clientGroupID: 'cg_depth',
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: 'c_depth',
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId: null,
                    timestamp_client: new Date().toISOString(),
                    listId,
                    workspaceId: null,
                    childElementRefs: [ids[0]!],
                    groups,
                    items: [],
                },
            },
        ],
    };
}

async function elementCount(stub: DurableObjectStub<DjibbList>): Promise<number> {
    return runInDurableObject(stub, async (_i, state) => {
        const tbl = state.storage.sql
            .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='list_elements';`)
            .toArray();
        if (tbl.length === 0) return 0; // guard threw before the table was created
        return Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM list_elements;`).one().n);
    });
}

describe('initList depth guard (§G)', () => {
    it('rejects a group tree nested past MAX_DEPTH, writing nothing', async () => {
        // MAX_DEPTH + 2 levels -> a group at depth MAX_DEPTH + 1 -> violation.
        const { listId, stub } = getListStub('depthbad');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeDeepInitPush(listId, MAX_DEPTH + 2),
        });
        // Push itself succeeds (skip-and-ack); the mutation is the thing rejected.
        expect(result.error).toBeNull();
        expect(await elementCount(stub)).toBe(0);
    });

    it('accepts a group tree exactly at MAX_DEPTH', async () => {
        const { listId, stub } = getListStub('depthok');
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeDeepInitPush(listId, MAX_DEPTH + 1),
        });
        expect(result.error).toBeNull();
        // entity + MAX_DEPTH+1 groups all landed.
        expect(await elementCount(stub)).toBe(MAX_DEPTH + 2);
    });
});
