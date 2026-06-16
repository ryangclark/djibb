import type { MutationName } from '@djibb/protocol/list/mutators';

/**
 * The envelope-wrapped mutator surface returned by `initList`. Body
 * args only — `accountId` / `timestamp_client` are injected by the
 * wrapper, not assembled at the call site.
 *
 * Keyed by the canonical {@link MutationName} union (the literal keys of
 * the workers `Mutations` registry) so call sites can reference named
 * mutators (`mutateWithUndo.setItemFields(...)`) and type-check.
 *
 * The runtime surface is a `Proxy` (envelope-injecting wrapper in
 * `index.svelte.js`) layered with the undo runtime, both of which
 * dispatch dynamically by name — so per-mutator arg/return types aren't
 * recoverable here. We model each entry as a loose async call; the wire
 * contract is enforced server-side by `parseMutationEnvelope` +
 * per-mutator `argsSchema`, not by this client-facing type.
 */
export type ClientListMutators = {
	[K in MutationName]: (args?: any) => Promise<any>;
};
