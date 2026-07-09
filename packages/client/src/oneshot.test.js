// @ts-check
import { describe, expect, it } from 'vitest';
import { newOneShotClient, pullEntity, pushMutation } from './oneshot.js';

/**
 * A stub transport recording every call, standing in for the real one.
 *
 * @param {unknown} [postResult]
 */
function stubTransport(postResult) {
	/** @type {{ path: string, opts: any }[]} */
	const calls = [];
	const transport = /** @type {import('./transport.js').Transport} */ (
		/** @type {unknown} */ ({
			post: async (/** @type {string} */ path, /** @type {any} */ opts) => {
				calls.push({ path, opts });
				return postResult;
			}
		})
	);
	return { transport, calls };
}

describe('newOneShotClient', () => {
	it('mints a distinct identity starting at mutation 1', () => {
		const a = newOneShotClient();
		const b = newOneShotClient();
		expect(a.mutationID).toBe(1);
		expect(a.clientID).not.toBe(b.clientID);
		expect(a.clientGroupID).not.toBe(b.clientGroupID);
	});
});

describe('pushMutation', () => {
	it('builds a push envelope from the supplied client identity', async () => {
		const { transport, calls } = stubTransport();
		const client = newOneShotClient();
		await pushMutation(transport, {
			client,
			kind: 'list',
			entityId: 'l/abc',
			name: 'createListItem',
			args: { item: { id: 'i/1' } },
			accountId: 'a/op'
		});

		expect(calls[0]?.path).toBe('/list/push?id=l%2Fabc');
		const body = calls[0]?.opts.json;
		expect(body.clientGroupID).toBe(client.clientGroupID);
		expect(body.pushVersion).toBe(1);
		expect(body.mutations).toHaveLength(1);

		const m = body.mutations[0];
		expect(m.id).toBe(client.mutationID);
		expect(m.clientID).toBe(client.clientID);
		expect(m.name).toBe('createListItem');
		// The envelope stamps the acting account and a client clock.
		expect(m.args.accountId).toBe('a/op');
		expect(m.args.item).toEqual({ id: 'i/1' });
		expect(typeof m.args.timestamp_client).toBe('string');
	});

	it("declares parse: 'none' — /push answers an empty 200", async () => {
		const { transport, calls } = stubTransport();
		await pushMutation(transport, {
			client: newOneShotClient(),
			kind: 'list',
			entityId: 'l/abc',
			name: 'createListItem',
			args: {},
			accountId: null
		});
		expect(calls[0]?.opts.parse).toBe('none');
	});

	it('writes anonymously when accountId is null', async () => {
		const { transport, calls } = stubTransport();
		await pushMutation(transport, {
			client: newOneShotClient(),
			kind: 'list',
			entityId: 'l/abc',
			name: 'createListItem',
			args: {},
			accountId: null
		});
		expect(calls[0]?.opts.json.mutations[0].args.accountId).toBe(null);
	});

	it('retrying with the SAME client resends one identity — the dedup key', async () => {
		// This is the whole point of taking `client` as a parameter. The DO
		// dedupes on (clientID, mutationID): a resend of an already-applied
		// mutation is acked without writing. Mint per attempt instead, and
		// each retry looks like a brand-new client with lastMutationID 0, so
		// the mutation applies twice.
		const { transport, calls } = stubTransport();
		const client = newOneShotClient();
		const push = () =>
			pushMutation(transport, {
				client,
				kind: 'list',
				entityId: 'l/abc',
				name: 'createListItem',
				args: {},
				accountId: null
			});

		await push();
		await push(); // simulated retry

		const [first, second] = calls.map((c) => c.opts.json.mutations[0]);
		expect(second.clientID).toBe(first.clientID);
		expect(second.id).toBe(first.id);
		expect(calls[0]?.opts.json.clientGroupID).toBe(calls[1]?.opts.json.clientGroupID);
	});

	it('throws on reuse for a DIFFERENT mutation — the DO would silently skip it', async () => {
		// The failure mode this guards is nasty: the DO dedupes on
		// (clientID, mutationID), so a second, different mutation pushed with
		// a used identity is acked as "from the past" without writing —
		// data loss with a success exit code.
		const { transport } = stubTransport();
		const client = newOneShotClient();
		await pushMutation(transport, {
			client,
			kind: 'list',
			entityId: 'l/abc',
			name: 'createListItem',
			args: { item: { id: 'i/1' } },
			accountId: null
		});
		await expect(
			pushMutation(transport, {
				client,
				kind: 'list',
				entityId: 'l/abc',
				name: 'createListItem',
				args: { item: { id: 'i/2' } },
				accountId: null
			})
		).rejects.toThrow(/reused for a different mutation/);
	});

	it('a failed first attempt still pins the client, so its retry is allowed', async () => {
		// Intent is recorded before the send: a transport error on attempt 1
		// must not leave the client unpinned or block the retry.
		let fail = true;
		/** @type {string[]} */
		const sent = [];
		const transport = /** @type {import('./transport.js').Transport} */ (
			/** @type {unknown} */ ({
				post: async (/** @type {string} */ path) => {
					if (fail) {
						fail = false;
						throw new Error('boom');
					}
					sent.push(path);
				}
			})
		);
		const client = newOneShotClient();
		const push = () =>
			pushMutation(transport, {
				client,
				kind: 'list',
				entityId: 'l/abc',
				name: 'createListItem',
				args: { item: { id: 'i/1' } },
				accountId: null
			});
		await expect(push()).rejects.toThrow('boom');
		await push(); // retry of the same mutation: allowed
		expect(sent).toHaveLength(1);
	});
});

describe('pullEntity', () => {
	it('sends a baseline pull and returns only put ops', async () => {
		const { transport, calls } = stubTransport({
			patch: [
				{ op: 'clear' },
				{ op: 'put', key: 'k1', value: { a: 1 } },
				{ op: 'del', key: 'k2' },
				{ op: 'put', key: 'k3', value: null }
			]
		});

		const puts = await pullEntity(transport, { entityId: 'l/abc' });

		expect(calls[0]?.path).toBe('/list/pull?id=l%2Fabc');
		expect(calls[0]?.opts.json.cookie).toBe(null);
		expect(calls[0]?.opts.json.pullVersion).toBe(1);
		expect(puts).toEqual([{ op: 'put', key: 'k1', value: { a: 1 } }]);
	});

	it('tolerates a patch-less response', async () => {
		const { transport } = stubTransport({});
		expect(await pullEntity(transport, { entityId: 'l/abc' })).toEqual([]);
	});

	it('routes templates to the template path', async () => {
		const { transport, calls } = stubTransport({ patch: [] });
		await pullEntity(transport, { entityId: 't/abc', kind: 'template' });
		expect(calls[0]?.path).toBe('/template/pull?id=t%2Fabc');
	});
});
