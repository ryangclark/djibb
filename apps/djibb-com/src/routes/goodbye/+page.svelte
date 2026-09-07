<script>
	// Landing after a completed account deletion (GH #58). The session cookie is
	// already cleared server-side by the time we arrive; this is a plain,
	// unauthenticated goodbye rather than a snap back to a signed-out /accounts.
</script>

<section class="goodbye">
	<h1 class="text-2xl mb-2">Your account is deleted</h1>
	<p>
		That identity is gone — you've been signed out everywhere and any connected
		app has lost access.
	</p>
	<p>
		No hard feelings. If you ever want to come back, you can sign up again with
		the same email; you'll simply start fresh.
	</p>
	<p class="mt-6">
		<a href="/">Back to djibb</a>
	</p>
</section>

<style>
	.goodbye {
		max-width: 40rem;
	}
	.goodbye p {
		margin: 0.5rem 0;
	}
</style>
