<script>
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		fetchInvitationPreview,
		acceptInvitation
	} from '$lib/api/invitation';
	import { getSessionState } from '$lib/session.svelte';

	const session = getSessionState();
	const token = $derived(page.params.token);

	/** @type {import('$lib/api/invitation').InvitationPreview|null} */
	let preview = $state(null);
	let error = $state('');
	let loading = $state(true);
	let accepting = $state(false);

	/** @type {string} active account chosen for accept */
	let chosenAccountId = $state('');

	const API_BASE = import.meta.env.VITE_API_BASE_URL;

	$effect(() => {
		if (!token) return;
		loading = true;
		fetchInvitationPreview(token)
			.then(p => {
				preview = p;
				error = '';
			})
			.catch(e => {
				error = /** @type {Error} */ (e).message ?? String(e);
			})
			.finally(() => {
				loading = false;
			});
	});

	$effect(() => {
		if (!chosenAccountId && session.accounts.length === 1) {
			chosenAccountId = session.accounts[0].id;
		}
	});

	async function onAccept() {
		if (!chosenAccountId) {
			error = 'Pick an account.';
			return;
		}
		accepting = true;
		error = '';
		try {
			const result = await acceptInvitation(token, chosenAccountId);
			await session.refreshWorkspaces();
			session.setActiveWorkspace(result.workspace_slug);
			await goto(`/w/${result.workspace_slug}`);
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		} finally {
			accepting = false;
		}
	}

	function signInWithGoogle() {
		// Carry the token through OAuth via the `?invite=` query.
		const url = new URL(`${API_BASE}/auth/google`);
		url.searchParams.set('invite', token);
		window.location.href = url.toString();
	}
</script>

<div class="m-8 max-w-md">
	{#if loading}
		<p>Loading invitation…</p>
	{:else if error}
		<p class="text-red-600">{error}</p>
	{:else if preview}
		{#if preview.status !== 'pending'}
			<h1 class="text-xl mb-2">This invitation is no longer valid</h1>
			<p class="text-stone-600">Status: {preview.status}.</p>
		{:else}
			<h1 class="text-xl mb-2">
				Join <strong>{preview.workspace.name ?? preview.workspace.slug}</strong>
			</h1>
			<p class="text-sm text-stone-600 mb-4">
				{preview.inviter.display_name} invited you as <em>{preview.role}</em>.
				Expires {new Date(preview.time_expires).toLocaleDateString()}.
			</p>

			{#if !session.accounts.length}
				<p class="mb-3">Sign in to accept:</p>
				<button onclick={signInWithGoogle} class="border px-4 py-2">
					Sign in with Google
				</button>
			{:else}
				{#if session.accounts.length > 1}
					<label class="flex flex-col text-sm mb-3">
						Accept as
						<select bind:value={chosenAccountId} class="border p-1">
							{#each session.accounts as a}
								<option value={a.id}>
									{a.display_name} ({a.email ?? a.id})
								</option>
							{/each}
						</select>
					</label>
				{/if}
				<button
					disabled={accepting || !chosenAccountId}
					onclick={onAccept}
					class="border px-4 py-2"
				>
					{accepting ? 'Joining…' : 'Accept invitation'}
				</button>
			{/if}
		{/if}
	{/if}
</div>
