// @ts-check
/**
 * One-shot Replicache push/pull, for clients with no sync loop (arch-review #5).
 *
 * The Durable Object's mutator pipeline is the *only* write door (ADR 0003:
 * the DO is the single writer). So a CLI, bot, or integration that wants to
 * write has to speak the Replicache push protocol — there is no REST write
 * surface, and adding one would mean re-inventing the idempotency this
 * protocol already provides. These helpers let a client speak it for a single
 * mutation without standing up a real Replicache instance.
 *
 * ## Client identity is a parameter, not an implementation detail
 *
 * Replicache dedupes by `(clientID, mutationID)`: the DO tracks each client's
 * `lastMutationID` and treats a mutation from the past as already-applied —
 * it acks without writing (`durable_object.ts`, "Mutation from the past!").
 * **That is the idempotency key**, and it is the reason a retried push doesn't
 * double-write.
 *
 * It only works if identity is minted **once per logical mutation** and reused
 * across retries. Mint it per *attempt* — as the CLI used to, with a
 * `randomUUID()` buried inside the push helper — and every retry arrives as a
 * brand-new client with `lastMutationID: 0`, so `id: 1` is "expected" and the
 * mutation applies *again*. A push that commits and then fails on the way back
 * (the DO emits its D1 snapshot synchronously on the same request) is exactly
 * the window this closes.
 *
 * So: call `newOneShotClient()` once, then retry `pushMutation` with that same
 * client. The retry loop wraps the transport call, never the identity mint.
 *
 * @see docs/creating-a-client.md
 */

/**
 * A one-shot client's Replicache identity. `mutationID` must be the target's
 * `lastMutationID + 1` for this `clientID` — for a freshly minted client the
 * server knows nothing about, that is always `1`.
 *
 * @typedef {object} OneShotClient
 * @property {string} clientGroupID
 * @property {string} clientID
 * @property {number} mutationID
 */

/**
 * Mint a fresh identity for one logical mutation. Reuse it across retries of
 * that mutation; mint a new one for the next mutation.
 *
 * Note the cost: a push persists a `replicache_client_groups` + a
 * `replicache_clients` row in the target DO, and nothing collects them. One
 * row-pair per *intent* is the floor for an unauthenticated writer (a shared
 * stable identity would race — two writers both reading `lastMutationID: 5`
 * would both push `6`, and the DO would silently skip-and-ack the second).
 *
 * @returns {OneShotClient}
 */
export function newOneShotClient() {
	return {
		clientGroupID: globalThis.crypto.randomUUID(),
		clientID: globalThis.crypto.randomUUID(),
		mutationID: 1
	};
}

/**
 * POST one mutation to an entity's `/push`.
 *
 * The caller's `accountId` is stamped into the mutation envelope. It is not a
 * claim of authority — the server's auth layer resolves the *credential* on
 * the transport to a role, and the DO cross-checks the two agree. Pass `null`
 * to write anonymously (the DO then resolves the entity's `default_role`).
 *
 * @param {import('./transport.js').Transport} transport
 * @param {object} input
 * @param {OneShotClient} input.client Minted once per logical mutation.
 * @param {'list'|'template'} input.kind
 * @param {string} input.entityId
 * @param {string} input.name Mutator name, e.g. `createListItem`.
 * @param {Record<string, unknown>} input.args Mutator body args.
 * @param {string|null} input.accountId Acting Account, or null for anonymous.
 * @param {string} [input.profileID] Replicache profile id; informational.
 * @returns {Promise<void>}
 */
export async function pushMutation(
	transport,
	{ client, kind, entityId, name, args, accountId, profileID = 'djibb-client' }
) {
	await transport.post(`/${kind}/push?id=${encodeURIComponent(entityId)}`, {
		json: {
			profileID,
			clientGroupID: client.clientGroupID,
			pushVersion: 1,
			schemaVersion: '',
			mutations: [
				{
					id: client.mutationID,
					clientID: client.clientID,
					name,
					args: {
						...args,
						accountId,
						timestamp_client: new Date().toISOString()
					},
					timestamp: Date.now()
				}
			]
		},
		// `/push` answers `new Response(null, { status: 200 })` — an empty 200,
		// so there is nothing to parse.
		parse: 'none'
	});
}

/** One element op from a `/pull` response patch. */
/** @typedef {{ op: 'put', key: string, value: Record<string, unknown> }} PullPut */

/**
 * POST a fresh (`cookie: null`) `/pull` for an entity and return its `put` ops.
 *
 * Reads are role-gated by the view floor (ADR 0021, #13): a below-floor caller
 * (the Contributed List is `default_role: 'submitter'`) gets an empty patch, so
 * an anonymous pull sees nothing. Present a credential that resolves above the
 * floor to read the tree.
 *
 * Unlike push, a pull persists nothing server-side — the DO builds its client
 * group in memory — so a throwaway `clientGroupID` here is free.
 *
 * @param {import('./transport.js').Transport} transport
 * @param {object} input
 * @param {string} input.entityId
 * @param {'list'|'template'} [input.kind]
 * @param {string} [input.profileID]
 * @returns {Promise<PullPut[]>}
 */
export async function pullEntity(
	transport,
	{ entityId, kind = 'list', profileID = 'djibb-client' }
) {
	const body = /** @type {{ patch?: Array<Record<string, unknown>> }} */ (
		await transport.post(`/${kind}/pull?id=${encodeURIComponent(entityId)}`, {
			json: {
				pullVersion: 1,
				profileID,
				clientGroupID: globalThis.crypto.randomUUID(),
				cookie: null,
				schemaVersion: ''
			}
		})
	);
	return /** @type {PullPut[]} */ (
		(body.patch ?? []).filter(
			(p) => p.op === 'put' && typeof p.value === 'object' && p.value !== null
		)
	);
}
