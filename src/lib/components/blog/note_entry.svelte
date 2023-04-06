<script lang="ts">
	export let key: string;
</script>

<div data-component-name="note-entry" id="note-entry:{key}">
	<a href="#note-link:{key}">*</a>: <slot />
</div>

<style>
	div {
		/* This offsets the note text from the link so multiple lines 
		don't appear beneath the link, which is nice. It's nice for
		small links, though, so reconsider if using long link text. */
		display: flex;
		margin: 1rem 0;
	}
</style>
