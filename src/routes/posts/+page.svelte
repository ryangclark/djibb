<script lang="ts">
	import type { PageData } from './$types';
	import PostPreview from '$lib/components/blog/post_preview.svelte';
	// import PageHead from '$lib/components/PageHead.svelte';
	// import Article from '$lib/components/Article.svelte';
	// import ArticleTitle from '$lib/components/ArticleTitle.svelte';
	// import ArticleMeta from '$lib/components/ArticleMeta.svelte';
	// import ArticleDescription from '$lib/components/ArticleDescription.svelte';
	export let data: PageData;
</script>

<h1 class="mb-6 mt-6 text-4xl">Blog</h1>
<p>This is the blog I'm using to document my building of the app.</p>
<h2 class="mb-6 mt-6 text-3xl">Posts</h2>

<!-- {#each data.posts as { author_name, created_at, description, slug, title }}
	<PostPreview {author_name} {created_at} {description} {slug} {title} />
{/each} -->
{#each data.posts_metadata as metadata}
	<PostPreview
		author_name={metadata.author_name}
		created_at={metadata.created_at}
		description={metadata.description}
		slug={metadata.slug}
		title={metadata.title}
	/>
{/each}

<slot />
