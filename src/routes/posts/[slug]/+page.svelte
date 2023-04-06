<script lang="ts">
	import type { PageData } from './$types';

	export let data: PageData;

	// https://github.com/mvasigh/sveltekit-mdsvex-blog/blob/main/src/routes/posts/%5Bslug%5D/%2Bpage.svelte
	type C = $$Generic<typeof SvelteComponentTyped<any, any, any>>;
	$: component = data.component as unknown as C;
</script>

<svelte:component this={component} />
