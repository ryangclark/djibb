import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '@djibb/protocol/id';

// Push-time authorization reconciliation policy (see `handleMutation`
// in `../src/list/durable_object.ts`).
//
// A role-gate denial during a push is resolved one of two ways, and the
// discriminator is whether the request is AUTHENTICATED — because that's
// the only signal that distinguishes a permanent denial from a transient
// one:
//
//   • AUTHENTICATED actor, role genuinely too low (signed-in viewer, or
//     an editor whose access was revoked) → PERMANENT. Skip-and-ack:
//     advance lastMutationID, write nothing, return success. Replicache
//     reconciles the optimistic write on the next pull instead of wedging
//     its push retry loop on a 403.
//
//   • UNAUTHENTICATED request (no session — `HandleSession` blanks an
//     expired/invalid cookie to null rather than throwing) → POSSIBLY
//     TRANSIENT. It may be an OWNER whose token expired while editing
//     OFFLINE; their role resolves to the entity's `default_role`
//     (`restricted` on an owned list) and the gate denies. Throw, so
//     Replicache keeps the mutation pending and retries — once the user
//     re-authenticates (fresh cookie) the same push lands with NO DATA
//     LOSS. Skip-and-ack here would silently discard real offline edits.
//
// The genuinely-anonymous doomed-init case (the homepage example Blank)
// is prevented client-side (`skipClientInit` gated on `?new=1`), so it
// never reaches the unauthenticated-throw path to wedge a retry loop.
//
// These two tests pin both branches side-by-side with `renameList` (an
// EDIT_ROLES mutator) standing in for "a real content edit."

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
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
    accountId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    accountId: string | null;
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
                    accountId,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                },
            },
        ],
    };
}

function makeRenameListPush({
    clientGroupID,
    clientID,
    listId,
    mutationId,
    name,
    accountId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    mutationId: number;
    name: string;
    accountId: string | null;
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
                name: 'renameList',
                timestamp: Date.now(),
                args: {
                    accountId,
                    listId,
                    name,
                    timestamp_client: new Date().toISOString(),
                },
            },
        ],
    };
}

async function readName(stub: DurableObjectStub<DjibbList>, listId: string) {
    const row = await runInDurableObject(stub, async (_i, state) =>
        state.storage.sql
            .exec<{ name: string }>(
                `SELECT name FROM list_elements WHERE id = ?;`,
                listId
            )
            .one()
    );
    return row.name;
}

describe('push auth reconciliation', () => {
    it('AUTHENTICATED actor, role too low → skip-and-ack (reconciles, no error, nothing written)', async () => {
        const { listId, stub } = getListStub('authrecon1');
        const clientGroupID = 'cg_authrecon_1';
        const clientID = 'c_authrecon_1';
        const ownerId = `${IdTypes.account}/owner_authrecon_aaaaa`;

        // Seed an owned list (default_role `restricted`).
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: ownerId,
            }),
        });

        // A DIFFERENT signed-in account whose role on this entity is only
        // `viewer` pushes an edit. Authenticated + denied = permanent.
        const viewerId = `${IdTypes.account}/viewer_authrecon_aa`;
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: viewerId } as any],
            authorizedRole: 'viewer',
            listId,
            pushRequest: makeRenameListPush({
                clientGroupID: 'cg_authrecon_1b',
                clientID: 'c_authrecon_1b',
                listId,
                mutationId: 1,
                name: 'Forbidden Rename',
                accountId: viewerId,
            }),
        });

        // Skip-and-ack: the push SUCCEEDS (no error) so Replicache advances
        // lastMutationID and rolls the optimistic rename back on next pull,
        // rather than retrying a 403 forever.
        expect(result.error).toBeNull();

        // …and the entity is untouched — acking never applies the write.
        expect(await readName(stub, listId)).not.toBe('Forbidden Rename');
    });

    it('OFFLINE OWNER whose token expired → throws (retryable, so offline edits survive re-auth)', async () => {
        const { listId, stub } = getListStub('authrecon2');
        const clientGroupID = 'cg_authrecon_2';
        const clientID = 'c_authrecon_2';
        const ownerId = `${IdTypes.account}/owner_authrecon2_aaa`;

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerId } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: ownerId,
            }),
        });

        // The owner edited OFFLINE: the queued mutation's envelope carries
        // `accountId: ownerId` (authored while authed). The token then
        // expired, so on reconnect the request has no session (empty
        // accounts). The mutation now claims an account the session doesn't
        // hold — rejected by the envelope cross-account guard, which throws
        // BEFORE the role gate. (Belt: even past that guard the role would
        // resolve to the owned list's `restricted` default and deny.) The
        // throw is the point: this is precisely the case that must NOT be
        // skip-and-ack'd, or the offline edit would be discarded.
        const result = await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'restricted',
            listId,
            pushRequest: makeRenameListPush({
                clientGroupID,
                clientID,
                listId,
                mutationId: 2,
                name: 'Offline Edit',
                accountId: ownerId,
            }),
        });

        // Throw → the push fails, so Replicache keeps the mutation PENDING
        // and retries. The edit is NOT discarded; it lands once the client
        // re-authenticates with a fresh cookie.
        expect(result.error).not.toBeNull();
        expect(result.error?.name).toMatch(/Unauthorized/i);

        // The pending edit hasn't been applied (still denied) — but
        // crucially it also hasn't been ack'd away.
        expect(await readName(stub, listId)).not.toBe('Offline Edit');
    });
});
