<section
	class="footnote-container"
	data-component-name="footnote-container"
	id="footnote-container"
>
	<slot />
</section>

<style>
	/* TODO: move these styles to layout files, hopefully with Tailwind */
	section {
		padding: 1rem;
	}
	section::before {
		content: 'Footnotes';
		display: block;
		font-size: 0.8rem;
		letter-spacing: 0.1rem;
		margin: 2rem 0 0.5rem;
		text-transform: uppercase;
	}
</style>
