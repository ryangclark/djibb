<script lang="ts">
	// Find the companion note
	// Create link to that note
	// Magic stuff to assign numbers in order...?

	export let key: string;
	// Can figure out something magical to set this variable to be the
	// number in order of its appearance in the doc.
	let noteText = '*';

	// Can't use this code because `document` is undefined in the
	// server.
	// const matchingEntryElement = document?.querySelector(
	// 	`div[data-component-name="note-entry"][data-key="${key}"]`
	// );
	// console.log('matchingEntryElement', matchingEntryElement);
</script>

<a data-component-name="note-link" href="#note-entry:{key}" id="note-link:{key}">
	<sup>{noteText}</sup>
</a>
