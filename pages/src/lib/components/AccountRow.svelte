<script>
	import { OAUTH_PROVIDER_PRETTY } from '$djibb/auth/constants';

	/**
	 * @type {{account: import("$djibb/account/index").Account}}
	 */
	const { account } = $props();
</script>

<div class="flex gap-4">
	<!-- UPGRADE: create a backup avatar img -->
	<img alt="account flag" src={account.image || ''} />

	<div>
		{#if account.provider_name}
			<p class="text-stone-500 text-sm">
				{OAUTH_PROVIDER_PRETTY[account.provider_name] || account.provider_name}
			</p>
		{/if}
		<h3 class="text-lg">
			{#if account.display_name}
				{account.display_name}
			{:else}
				<span class="italic">nameless</span>
			{/if}
		</h3>
		{#if account.email}
			<!-- UPGRADE: Make email click-to-copy -->
			<p>{account.email}</p>
			<!-- UPGRADE: indicate whether email is verified, and allow start of verification flow if available -->
		{/if}
	</div>
</div>
