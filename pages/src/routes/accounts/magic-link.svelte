<script>
	// @ts-check
	/**
	 * Magic-link sign-in form. Lives next to the Google OAuth button on
	 * /accounts; the two are alternative paths into the same Account
	 * resolution (ADR 0010 — email-match-first).
	 *
	 * State machine:
	 *   idle    → user types, can submit
	 *   sending → request in flight; button disabled
	 *   sent    → success message, resend button disabled until cooldown
	 *   error   → message shown, can retry immediately
	 *
	 * Resend cooldown is enforced client-side here (60s) to match the
	 * server-side rate-limit policy that hasn't landed yet (ADR 0010
	 * §"Policy defaults"). This is UX-only; do not depend on it for
	 * security — the server will own the canonical limit.
	 */
	import {
		MagicLinkRateLimitError,
		requestMagicLink
	} from '$lib/api/magicLink.js';

	/** @typedef {'idle' | 'sending' | 'sent' | 'error'} Phase */

	let phase = /** @type {Phase} */ ($state('idle'));

	let email = $state('');

	/** @type {string} */
	let errorMessage = $state('');

	/** Seconds remaining on the resend cooldown (0 = ready). */
	let cooldownRemaining = $state(0);

	/** Client-side default cooldown after a successful send. The
	 * server enforces the canonical limit; this matches it so the
	 * resend button doesn't re-enable before the server would
	 * accept another request. On rate-limit errors we honor the
	 * server's exact retry-after instead. */
	const COOLDOWN_SECONDS = 60;

	// Pragmatic shape check — the worker re-validates server-side.
	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	let trimmed = $derived(email.trim());
	let emailLooksValid = $derived(EMAIL_RE.test(trimmed));

	let submitDisabled = $derived(
		phase === 'sending' || !emailLooksValid || cooldownRemaining > 0
	);

	/** @type {ReturnType<typeof setInterval> | null} */
	let cooldownTimer = null;

	/** @param {number} seconds */
	function startCooldown(seconds) {
		cooldownRemaining = seconds;
		if (cooldownTimer) clearInterval(cooldownTimer);
		cooldownTimer = setInterval(() => {
			cooldownRemaining -= 1;
			if (cooldownRemaining <= 0) {
				cooldownRemaining = 0;
				if (cooldownTimer) {
					clearInterval(cooldownTimer);
					cooldownTimer = null;
				}
			}
		}, 1000);
	}

	/**
	 * Map server-side rate-limit reasons to user-visible messages.
	 * Keep these honest but kind — the user already knows they
	 * clicked a few too many times.
	 * @param {string | null} reason
	 * @param {number} seconds
	 */
	function rateLimitMessage(reason, seconds) {
		switch (reason) {
			case 'cooldown':
				return `Please wait ${seconds}s before requesting another link.`;
			case 'email_15min':
			case 'email_24h':
				return `Too many sign-in attempts for this email. Try again in ${seconds}s.`;
			case 'ip_hour':
				return `Too many sign-in attempts from this network. Try again in ${seconds}s.`;
			default:
				return `Please wait ${seconds}s and try again.`;
		}
	}

	/** @param {Event} e */
	async function handleSubmit(e) {
		e.preventDefault();
		if (submitDisabled) return;

		phase = 'sending';
		errorMessage = '';

		try {
			await requestMagicLink({ email: trimmed });
			phase = 'sent';
			startCooldown(COOLDOWN_SECONDS);
		} catch (err) {
			if (err instanceof MagicLinkRateLimitError) {
				// Server says we're rate-limited; show the precise wait
				// and start a cooldown matching the server's value so
				// the resend button re-enables at the right time.
				phase = 'error';
				errorMessage = rateLimitMessage(
					err.reason,
					err.retryAfterSeconds
				);
				startCooldown(err.retryAfterSeconds);
			} else {
				phase = 'error';
				errorMessage =
					err instanceof Error
						? err.message
						: 'Could not send sign-in email. Try again.';
			}
		}
	}

	$effect(() => {
		// Cleanup the interval if the component unmounts mid-cooldown.
		return () => {
			if (cooldownTimer) clearInterval(cooldownTimer);
		};
	});
</script>

<form class="magic-form" onsubmit={handleSubmit}>
	<label class="label" for="magic-email">Email me a sign-in link</label>
	<div class="row">
		<input
			id="magic-email"
			type="email"
			autocomplete="email"
			inputmode="email"
			placeholder="you@example.com"
			bind:value={email}
			disabled={phase === 'sending'}
			required
		/>
		<button type="submit" disabled={submitDisabled}>
			{#if phase === 'sending'}
				Sending…
			{:else if cooldownRemaining > 0}
				Resend in {cooldownRemaining}s
			{:else if phase === 'sent'}
				Resend
			{:else}
				Email me
			{/if}
		</button>
	</div>

	{#if phase === 'sent'}
		<p class="msg success">
			If that address has a djibb account, a sign-in link is on its way.
			Check your inbox — the link expires in 15 minutes.
		</p>
	{:else if phase === 'error'}
		<p class="msg error">{errorMessage}</p>
	{:else}
		<p class="msg hint">
			We'll send you a one-time link. No password required.
		</p>
	{/if}
</form>

<style>
	.magic-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 400px;
	}

	.label {
		font-weight: 500;
		font-size: 0.95rem;
	}

	.row {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font: inherit;
	}

	input:disabled {
		background: #f5f5f5;
		color: #888;
	}

	button {
		padding: 0.5rem 1rem;
		border: 1px solid #747775;
		border-radius: 4px;
		background: white;
		font: inherit;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
	}

	button:hover:not(:disabled) {
		background: #f5f5f5;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.msg {
		font-size: 0.85rem;
		margin: 0;
	}

	.msg.hint {
		color: #666;
	}

	.msg.success {
		color: #1a7f37;
	}

	.msg.error {
		color: #b00020;
	}
</style>
