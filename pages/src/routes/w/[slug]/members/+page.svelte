<script>
	import { fetchWorkspaceMembers } from '$lib/api/workspace';
	import { page } from '$app/state';

	const slug = $derived(page.params.slug);

	/** @type {import('$lib/api/workspace').WorkspaceMember[]} */
	let members = $state([]);
	let error = $state('');

	$effect(() => {
		if (!slug) return;
		fetchWorkspaceMembers(slug)
			.then(m => (members = m))
			.catch(e => (error = e?.message ?? String(e)));
	});
</script>

<h2 class="text-lg mb-2">Members</h2>

{#if error}
	<p class="text-red-600 text-sm">{error}</p>
{/if}

<table class="text-sm">
	<thead>
		<tr class="text-stone-500">
			<th class="text-left pr-6">Account</th>
			<th class="text-left pr-6">Role</th>
			<th class="text-left">Joined</th>
		</tr>
	</thead>
	<tbody>
		{#each members as m}
			<tr>
				<td class="pr-6 font-mono text-xs">{m.account_id}</td>
				<td class="pr-6">{m.role}</td>
				<td>{new Date(m.time_joined).toLocaleDateString()}</td>
			</tr>
		{/each}
	</tbody>
</table>
