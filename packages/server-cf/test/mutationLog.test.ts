// Workspace Phase 5 polish: the audit-log read path. Covers the DO's
// `getMutationLog` RPC and the underlying SQL helper — newest-first
// ordering, `seq`-cursor pagination ("load older"), epoch-normalized
// `timestamp_server` (the column is written as a CURRENT_TIMESTAMP
// string), captured actor + parsed args. The OWNER_ROLES gate lives at
// the HTTP boundary (`makeEntityRouter`) and is asserted there by the
// role-resolution tests; this file exercises the data layer the gate
// protects.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function getWorkspaceStub(suffix: string) {
    const prefixed = `${IdTypes.workspace}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        workspaceId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makePush<TBody extends Record<string, unknown>>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
    accountId = null,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
    accountId?: string | null;
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
                name,
                timestamp: Date.now(),
                args: {
                    accountId,
                    timestamp_client: new Date().toISOString(),
                    ...body,
                } as any,
            },
        ],
    };
}

async function mintWorkspace(suffix: string, ownerId: string) {
    const { workspaceId, stub } = getWorkspaceStub(suffix);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: { workspaceId, name: 'WS-' + suffix },
        }),
    });
    return { workspaceId, stub };
}

/** Push one more owner-authored mutation onto an existing workspace. */
async function pushRename(
    workspaceId: string,
    stub: DurableObjectStub<DjibbList>,
    ownerId: string,
    suffix: string,
    mutationId: number,
    name: string,
) {
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'renameWorkspace',
            mutationId,
            accountId: ownerId,
            body: { workspaceId, name },
        }),
    });
}

describe('getMutationLog — audit-log read path', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('returns the log newest-first with actor + parsed args + epoch ts', async () => {
        const owner = 'account/owner-audit-aaaaa';
        const { workspaceId, stub } = await mintWorkspace('audit01', owner);
        await pushRename(workspaceId, stub, owner, 'audit01', 2, 'Renamed One');

        const { data: entries, error } = await stub.getMutationLog({ limit: 50 });
        expect(error).toBeNull();
        expect(entries).not.toBeNull();
        const log = entries!;

        // Newest-first: the rename (mutation 2) precedes createWorkspace.
        expect(log.length).toBeGreaterThanOrEqual(2);
        expect(log[0]!.name).toBe('renameWorkspace');
        expect(log[log.length - 1]!.name).toBe('createWorkspace');

        // Actor is captured from the envelope.
        expect(log[0]!.account_id).toBe(owner);

        // Args are returned as the raw JSON string; the rename's new name
        // is in the body once parsed.
        expect(JSON.parse(log[0]!.args!).name).toBe('Renamed One');

        // timestamp_server is normalized to epoch seconds, not a string.
        expect(typeof log[0]!.timestamp_server).toBe('number');
        expect(log[0]!.timestamp_server!).toBeGreaterThan(1_600_000_000);

        // seq is monotonically increasing with insertion → newest has the
        // largest seq.
        expect(log[0]!.seq).toBeGreaterThan(log[log.length - 1]!.seq);
    });

    it('paginates older entries via the seq cursor', async () => {
        const owner = 'account/owner-audit-bbbbb';
        const { workspaceId, stub } = await mintWorkspace('audit02', owner);
        await pushRename(workspaceId, stub, owner, 'audit02', 2, 'R2');
        await pushRename(workspaceId, stub, owner, 'audit02', 3, 'R3');

        // First page of 2: the two newest.
        const first = await stub.getMutationLog({ limit: 2 });
        expect(first.error).toBeNull();
        const page1 = first.data!;
        expect(page1.length).toBe(2);

        // Older page starting before the last seq of page 1.
        const before = page1[page1.length - 1]!.seq;
        const second = await stub.getMutationLog({ limit: 2, before });
        expect(second.error).toBeNull();
        const page2 = second.data!;

        // No overlap, and every page-2 seq is older (smaller) than the cursor.
        const page1Seqs = new Set(page1.map(e => e.seq));
        for (const e of page2) {
            expect(e.seq).toBeLessThan(before);
            expect(page1Seqs.has(e.seq)).toBe(false);
        }
    });

    it('clamps limit and tolerates a null/absent cursor', async () => {
        const owner = 'account/owner-audit-ccccc';
        const { stub } = await mintWorkspace('audit03', owner);

        // limit below the floor is clamped to 1.
        const clamped = await stub.getMutationLog({ limit: 0, before: null });
        expect(clamped.error).toBeNull();
        expect(clamped.data!.length).toBe(1);
    });
});
