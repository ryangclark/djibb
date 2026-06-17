import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '@djibb/protocol/id';
import {
    decodeWSMessage,
    encodeWSMessage,
} from '@djibb/protocol/websocket/constants';

// B.1: per-mutation outcome channel substrate.
//
// Three things this exercises:
//   1. Wire-format round-trip (encode → decode is total + lossless).
//   2. clientID tagging at acceptWebSocket time — a `?c=<id>` upgrade
//      results in a socket that's routable via `getWebSockets(id)`.
//   3. Untagged upgrades still work — the graceful-deploy invariant
//      (ADR 0006).
//
// The actual mutation_outcome emission on CAS-stale is exercised
// implicitly by tests in setItemFields.test.ts and renameList tests
// at the runtime layer (B.2 will add the client-side listener +
// end-to-end coverage).

function getListStub(name: string) {
    const prefixed = `${IdTypes.list}/${name.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

describe('wire format', () => {
    it('encodeWSMessage / decodeWSMessage round-trips a poke', () => {
        const encoded = encodeWSMessage({ type: 'poke' });
        expect(decodeWSMessage(encoded)).toEqual({ type: 'poke' });
    });

    it('encodeWSMessage / decodeWSMessage round-trips a mutation_outcome', () => {
        const encoded = encodeWSMessage({
            type: 'mutation_outcome',
            mutationID: 42,
            status: 'stale',
        });
        expect(decodeWSMessage(encoded)).toEqual({
            type: 'mutation_outcome',
            mutationID: 42,
            status: 'stale',
        });
    });

    it('decodeWSMessage returns null for non-JSON / non-string input', () => {
        expect(decodeWSMessage('pull pls')).toBeNull(); // legacy plain string
        expect(decodeWSMessage(undefined)).toBeNull();
        expect(decodeWSMessage(123)).toBeNull();
    });
});

describe('clientID tagging at acceptWebSocket time', () => {
    it('upgrade with ?c=<clientID> tags the socket; getWebSockets(clientID) finds it', async () => {
        const { listId, stub } = getListStub('oc1');
        const clientID = 'c_oc_1';

        const wsKey = btoa('xxxxxxxxxxxxxxxx'); // 16 bytes → 24-char base64
        const upgrade = await stub.fetch(
            `https://djibb.dev/list/websocket?l=${listId}&c=${clientID}`,
            {
                headers: {
                    Upgrade: 'websocket',
                    Connection: 'Upgrade',
                    'Sec-WebSocket-Key': wsKey,
                    'Sec-WebSocket-Version': '13',
                },
            }
        );
        expect(upgrade.status).toBe(101);

        const tagged = await runInDurableObject(stub, async (instance, _state) => {
            // @ts-expect-error — accessing protected ctx is fine in tests
            return instance.ctx.getWebSockets(clientID).length;
        });
        expect(tagged).toBe(1);
    });

    it('upgrade WITHOUT ?c= still accepts; the socket is just untagged', async () => {
        const { listId, stub } = getListStub('oc2');

        const wsKey = btoa('yyyyyyyyyyyyyyyy'); // 24-char base64
        const upgrade = await stub.fetch(
            `https://djibb.dev/list/websocket?l=${listId}`,
            {
                headers: {
                    Upgrade: 'websocket',
                    Connection: 'Upgrade',
                    'Sec-WebSocket-Key': wsKey,
                    'Sec-WebSocket-Version': '13',
                },
            }
        );
        expect(upgrade.status).toBe(101);

        const counts = await runInDurableObject(
            stub,
            async (instance, _state) => {
                return {
                    // @ts-expect-error
                    untagged: instance.ctx.getWebSockets().length,
                    // @ts-expect-error
                    bogus: instance.ctx.getWebSockets('not-a-real-id').length,
                };
            }
        );
        expect(counts.untagged).toBeGreaterThanOrEqual(1);
        expect(counts.bogus).toBe(0);
    });
});
