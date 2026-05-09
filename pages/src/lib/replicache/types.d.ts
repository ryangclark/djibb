import type { initList } from './index.svelte';

/**
 * The envelope-wrapped mutator surface returned by `initList`. Body
 * args only — `accountId` / `timestamp_client` are injected by the
 * wrapper, not assembled at the call site.
 */
export type ClientListMutators = ReturnType<typeof initList>['mutate'];
