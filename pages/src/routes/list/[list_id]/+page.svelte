<script>
	import { initList } from '$lib/replicache/index.svelte.js';
	import { initialize as initWebsocket } from '$lib/websocket';

	import { WS_MESSAGE_PULL_PLS } from '$djibb/websocket/constants';

	import List from '$lib/components/List.svelte';

	// Can `list_id` change here...? Hmm
	let { data } = $props();

	/** @type {{ [x: string]: import('replicache').ReadonlyJSONValue }}*/
	let list_data = $state({});

	/** @type {import('$djibb/list').List}*/
	// @ts-ignore
	let list = $derived(list_data?.[`list/${data.list_id}`]);

	/** @type {import("$lib/replicache/types.js").ClientListMutators | undefined} */
	let mutators = $state();

	// Effects only run in the browser, not during server-side rendering.
	$effect(() => {
		const replicacheList = initList({
			list_id: data.list_id,
			user_id: data.user?.username || 'my-test-user'
		});

		list_data = replicacheList.list;
		mutators = replicacheList.client.mutate;

		const ws = initWebsocket(data.list_id);
		ws.addEventListener('message', (event) => {
			// console.log('MessageEvent:', event);

			if (event.data === WS_MESSAGE_PULL_PLS) {
				if (replicacheList) {
					console.log('triggering replicache pull!');

					replicacheList.client.pull();
				}
			}
		});

		// Return a cleanup function, which is called whenever the
		// effect refires as well as when the component is destroyed.
		return () => {
			console.log(`cleaning up after List "${data.list_id}"!`);
			replicacheList.client.close();
			ws?.close(1000);
		};
	});
</script>

{#if list && mutators}
	<List data={list_data} {list} {mutators}></List>
{:else}
	<!-- TODO: improve this fallback state? -->
	<p>uh oh?</p>
{/if}
