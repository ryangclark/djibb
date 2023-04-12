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

<div
	class="mt-8 mb-8 bg-gray-100 p-4 lg:p-6"
	data-component-name="post_preview"
	id="post-preview-{slug}"
>
	<p class="text-sm uppercase text-gray-600">
		{formatter.format(new Date(created_at))}
	</p>
	<a href="/posts/{slug}"><h3 class="mb-3 mt-1 text-2xl">{title}</h3></a>
	<p>{description}</p>
</div>
