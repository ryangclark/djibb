<script lang="ts">
	export let author_name: string;
	export let created_at: string;
	export let description: string;
	export let slug: string;
	export let title: string;

	const formatter = new Intl.DateTimeFormat('en', {
		dateStyle: 'long',
	});
</script>

<div data-component-name="post_preview" id="post-preview-{slug}">
	<a href="/posts/{slug}"><h3 class="mt-8 text-2xl">{title}</h3></a>
	<div class="mb-2 flex gap-6">
		<p class="text-sm uppercase text-gray-600">
			{formatter.format(new Date(created_at))}
		</p>
		{#if author_name}
			<p class="text-sm text-gray-600">
				<span class="text-xs uppercase">By:</span>
				{author_name}
			</p>
		{/if}
	</div>
	<p>{description}</p>
</div>
