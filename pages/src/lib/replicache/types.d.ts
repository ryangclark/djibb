import type { InitReplicacheClient } from './index.svelte';

type ListReplicacheClient = ReturnType<typeof InitReplicacheClient>;

export type ClientListMutators = ListReplicacheClient['mutate'];
