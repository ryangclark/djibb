<script>
	// @ts-check
	/**
	 * Auth-rules editor for a List or Template. Wraps the
	 * `setListAuthRules` mutator with a form-shaped UI:
	 *
	 *  - "Anyone with the link" — picks `default_role` for unauth'd
	 *    visitors. `restricted` is the "no public access" choice.
	 *  - "People with access" — table of accounts in
	 *    `authorization_rules.authorized_accounts`. Role select +
	 *    remove button per row. Adding new accounts requires
	 *    knowing an accountId, which is yet-unbuilt at the UI
	 *    level — see ADR 0005 / docs/plans for the invite primitive
	 *    follow-up.
	 *
	 * The save button collapses pending edits into a single
	 * mutation with `expected` set to the on-load rules, so a
	 * concurrent change by another admin gets a `stale` outcome
	 * (toasted by the runtime) rather than a silent clobber.
	 *
	 * Self-demotion guard: if the user is about to change their
	 * own role away from owner/admin (or remove themselves), we
	 * show a confirm modal. The mutator itself has no lockout
	 * guard server-side; this is the UI's polite refusal.
	 */
	import { tryCatchAsync } from '$djibb/utils/trycatch';

	const ROLE_LABELS = /** @type {const} */ ({
		owner: 'Owner',
		admin: 'Admin',
		editor: 'Editor',
		checker: 'Checker',
		viewer: 'Viewer'
	});

	const DEFAULT_ROLE_OPTIONS = /** @type {const} */ ([
		{ value: 'restricted', label: 'No public access' },
		{ value: 'viewer', label: 'Can view' },
		{ value: 'checker', label: 'Can check items off' },
		{ value: 'editor', label: 'Can edit' },
		{ value: 'ownerless', label: 'Free-for-all (no owner)' }
	]);

	const ASSIGNABLE_ACCOUNT_ROLES = /** @type {const} */ ([
		'owner',
		'admin',
		'editor',
		'checker',
		'viewer'
	]);

	const OWNER_ROLES = ['admin', 'owner'];

	/**
	 * @typedef {Object} PendingInvite
	 * @property {'email'} identity_kind
	 * @property {string} identity_value
	 * @property {import('$djibb/auth/rules').AccountRole} role
	 * @property {string} inviter_account_id
	 * @property {number} time_created  unix seconds
	 * @property {number} time_expires  unix seconds
	 */

	/**
	 * @typedef {Object} Props
	 * @property {string} entityId
	 * @property {'list' | 'template'} entityType
	 * @property {{
	 *     name: string | null,
	 *     authorization_rules: import('$djibb/auth/rules').AuthorizationRules
	 * }} entity
	 * @property {import('$lib/replicache/types').ClientListMutators} mutators
	 * @property {string | null} currentAccountId
	 * @property {string} backHref
	 * @property {PendingInvite[]} [pendingInvites]
	 *   Live pending invitations on this entity, surfaced by the
	 *   `pending_invites/*` Replicache keyspace (ADR 0009 Slice 2).
	 *   Visible only to owners/admins per the role-gated pull filter;
	 *   passed in by the route which filters `list_data` for keys
	 *   beginning with `pending_invites/`.
	 */

	/** @type {Props} */
	let {
		entityId,
		entityType,
		entity,
		mutators,
		currentAccountId,
		backHref,
		pendingInvites = []
	} = $props();

	// Snapshot of the rules at page load. The save call passes this
	// as `expected` so the server CAS catches a concurrent admin's
	// edit instead of clobbering it.
	let baseline = $state(structuredClone(entity.authorization_rules));

	// Draft mutates as the user edits; save commits draft to server,
	// then re-baselines on success.
	let draft = $state(structuredClone(entity.authorization_rules));

	let saving = $state(false);
	let savedAt = $state(/** @type {number | null} */ (null));
	let errorMsg = $state(/** @type {string | null} */ (null));

	// Self-demotion confirm. Holds the draft snapshot to apply if
	// the user confirms; null when no confirm is pending.
	let pendingDemotion = $state(
		/** @type {{ apply: () => Promise<void>, fromRole: string, toRole: string | null } | null} */ (
			null
		)
	);

	let myRole = $derived(
		(currentAccountId &&
			draft.authorized_accounts[currentAccountId]?.role) ||
			null
	);
	let baselineMyRole = $derived(
		(currentAccountId &&
			baseline.authorized_accounts[currentAccountId]?.role) ||
			null
	);
	let canManage = $derived(
		baselineMyRole !== null && OWNER_ROLES.includes(baselineMyRole)
	);

	let isDirty = $derived(
		JSON.stringify(baseline) !== JSON.stringify(draft)
	);

	let publicUrl = $derived(
		typeof window === 'undefined'
			? ''
			: `${window.location.origin}/${entityType === 'list' ? 'l' : 't'}/${entityId.split('/', 2)[1] ?? ''}`
	);

	let accountRows = $derived(
		Object.entries(draft.authorized_accounts).map(([id, v]) => ({
			id,
			role: v.role,
			isMe: id === currentAccountId
		}))
	);

	/**
	 * @param {import('$djibb/auth/rules').DefaultRole} value
	 */
	function setDefaultRole(value) {
		draft.default_role = value;
	}

	/**
	 * @param {string} accountId
	 * @param {import('$djibb/auth/rules').AccountRole} role
	 */
	function setAccountRole(accountId, role) {
		draft.authorized_accounts[accountId] = { role };
	}

	/** @param {string} accountId */
	function removeAccount(accountId) {
		delete draft.authorized_accounts[accountId];
	}

	function reset() {
		draft = structuredClone(baseline);
		errorMsg = null;
		savedAt = null;
	}

	async function save() {
		errorMsg = null;
		savedAt = null;

		// Self-demotion guard. Fires when the user holds a manage
		// role at baseline but the draft would land them outside
		// OWNER_ROLES (either downgraded or removed entirely). The
		// mutator has no lockout guard server-side — this is the
		// UI's polite refusal-by-confirm.
		if (
			currentAccountId &&
			baselineMyRole &&
			OWNER_ROLES.includes(baselineMyRole) &&
			(myRole === null || !OWNER_ROLES.includes(myRole))
		) {
			pendingDemotion = {
				fromRole: baselineMyRole,
				toRole: myRole,
				apply: doSave
			};
			return;
		}
		await doSave();
	}

	async function doSave() {
		saving = true;
		const next = structuredClone(draft);
		// `set_by` flips to 'user' the moment a real human edits;
		// `defaults` survives only until the first deliberate
		// change. ('workspace' is reserved for workspace-level
		// policy push, not implemented yet.)
		next.set_by = 'user';

		const result = await tryCatchAsync(
			mutators.setListAuthRules({
				listId: entityId,
				authorization_rules: next,
				expected: { authorization_rules: baseline }
			})
		);

		saving = false;

		if (result.error) {
			errorMsg = `Failed to save: ${result.error.message ?? result.error}`;
			return;
		}

		baseline = next;
		draft = structuredClone(next);
		savedAt = Date.now();
	}

	async function copyUrl() {
		if (!publicUrl) return;
		try {
			await navigator.clipboard.writeText(publicUrl);
		} catch {
			// Clipboard blocked; surface as a transient error.
			errorMsg = 'Copy failed — select and copy the URL manually.';
		}
	}

	function confirmDemotion() {
		if (!pendingDemotion) return;
		const apply = pendingDemotion.apply;
		pendingDemotion = null;
		void apply();
	}

	function cancelDemotion() {
		pendingDemotion = null;
	}

	// ADR 0009 Slice 3 — invite-by-email form. Fires the
	// `inviteByIdentity` mutator through Replicache normally. The
	// preflight (rate limit, outstanding cap, already-a-member, self-
	// invite) runs inside the DO push handler; failures don't reach
	// here as a thrown error, they surface over the WS outcome channel
	// and get routed to the global toast (UndoToast with `message`).
	// Local "Invitation sent" feedback is optimistic — the matching
	// pending_invite row appears under the section above on the next
	// pull (driven by the post-commit poke, <1s).
	let inviteEmail = $state('');
	let inviteRole = $state(
		/** @type {import('$djibb/auth/rules').AccountRole} */ ('editor')
	);
	let inviteSubmitting = $state(false);
	let inviteSentAt = $state(/** @type {number | null} */ (null));
	let inviteLocalError = $state(/** @type {string | null} */ (null));

	async function sendInvite() {
		inviteLocalError = null;
		inviteSentAt = null;
		const email = inviteEmail.trim();
		if (!email) {
			inviteLocalError = 'Enter an email address.';
			return;
		}
		if (!currentAccountId) {
			inviteLocalError = 'Sign in to send invitations.';
			return;
		}
		inviteSubmitting = true;
		const result = await tryCatchAsync(
			mutators.inviteByIdentity({
				listId: entityId,
				identity_kind: 'email',
				identity_value: email,
				role: inviteRole
			})
		);
		inviteSubmitting = false;

		if (result.error) {
			// Client-side mutator threw — this is a NotFoundError on
			// `tx.get(listId)` or similar; rare. Server-side preflight
			// failures (already_member / rate_limit / ...) flow through
			// the WS outcome channel and the global toast.
			inviteLocalError = `Failed to send: ${result.error.message ?? result.error}`;
			return;
		}
		inviteEmail = '';
		inviteSentAt = Date.now();
	}

	// Pending-invitation revoke flow. The mutator goes through the
	// standard Replicache push — no HTTP preflight gate (unlike
	// `inviteByIdentity` / `acceptInvitation`), so failures flow back
	// through the outcome channel as usual. Owners/admins only; the
	// pull filter wouldn't have surfaced the rows otherwise.
	let revoking = $state(/** @type {Set<string>} */ (new Set()));
	let revokeError = $state(/** @type {string | null} */ (null));

	let pendingInviteRows = $derived(
		(pendingInvites ?? [])
			.slice()
			.sort((a, b) => a.time_created - b.time_created)
	);

	/** @param {PendingInvite} invite */
	async function revoke(invite) {
		revokeError = null;
		const key = `${invite.identity_kind}|${invite.identity_value}`;
		if (revoking.has(key)) return;
		revoking.add(key);
		revoking = new Set(revoking);

		const result = await tryCatchAsync(
			mutators.revokeInvitation({
				listId: entityId,
				identity_kind: invite.identity_kind,
				identity_value: invite.identity_value
			})
		);

		revoking.delete(key);
		revoking = new Set(revoking);

		if (result.error) {
			revokeError = `Failed to revoke: ${result.error.message ?? result.error}`;
		}
	}

	/**
	 * Format unix seconds as a relative-ish label suitable for the
	 * row metadata ("expires in 6 days", "expired"). Cheap; no date
	 * library — the UI just needs a glanceable hint.
	 * @param {number} timeExpiresSeconds
	 */
	function expiryLabel(timeExpiresSeconds) {
		const nowSec = Math.floor(Date.now() / 1000);
		const deltaSec = timeExpiresSeconds - nowSec;
		if (deltaSec <= 0) return 'expired';
		const days = Math.floor(deltaSec / 86400);
		if (days >= 2) return `expires in ${days} days`;
		if (days === 1) return 'expires tomorrow';
		const hours = Math.floor(deltaSec / 3600);
		if (hours >= 2) return `expires in ${hours}h`;
		if (hours === 1) return 'expires in 1h';
		return 'expires soon';
	}
</script>

<svelte:head>
	<title>Share {entityType} — djibb</title>
</svelte:head>

<main>
	<header>
		<a href={backHref} class="back">← Back</a>
		<h1>Share {entityType}</h1>
		{#if entity.name}<p class="entity-name">{entity.name}</p>{/if}
	</header>

	{#if !canManage}
		<p class="notice">
			You can view the share settings but only an owner or admin can
			change them. (Your role here:
			<code>{baselineMyRole ?? baseline.default_role}</code>.)
		</p>
	{/if}

	<section>
		<h2>Anyone with the link</h2>
		<p class="hint">
			What someone gets when they open the URL without being
			explicitly granted access.
		</p>
		<div class="role-options">
			{#each DEFAULT_ROLE_OPTIONS as opt (opt.value)}
				<label class:selected={draft.default_role === opt.value}>
					<input
						type="radio"
						name="default-role"
						value={opt.value}
						checked={draft.default_role === opt.value}
						disabled={!canManage}
						onchange={() => setDefaultRole(opt.value)}
					/>
					<span>{opt.label}</span>
				</label>
			{/each}
		</div>

		{#if draft.default_role !== 'restricted'}
			<div class="url-row">
				<input
					type="text"
					readonly
					value={publicUrl}
					onclick={(e) => e.currentTarget.select()}
				/>
				<button type="button" onclick={copyUrl}>Copy</button>
			</div>
		{/if}
	</section>

	<section>
		<h2>People with access</h2>
		{#if accountRows.length === 0}
			<p class="hint">
				No one has been granted individual access yet. Visibility
				is controlled by the link setting above.
			</p>
		{:else}
			<ul class="account-list">
				{#each accountRows as row (row.id)}
					<li>
						<span class="account-id">
							<code>{row.id}</code>
							{#if row.isMe}<span class="me-badge">you</span>{/if}
						</span>
						<select
							value={row.role}
							disabled={!canManage}
							onchange={(e) =>
								setAccountRole(
									row.id,
									/** @type {import('$djibb/auth/rules').AccountRole} */ (
										e.currentTarget.value
									)
								)}
						>
							{#each ASSIGNABLE_ACCOUNT_ROLES as r (r)}
								<option value={r}>{ROLE_LABELS[r]}</option>
							{/each}
						</select>
						<button
							type="button"
							class="remove"
							disabled={!canManage}
							onclick={() => removeAccount(row.id)}
						>
							Remove
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if canManage}
			<form
				class="invite-form"
				onsubmit={(e) => {
					e.preventDefault();
					void sendInvite();
				}}
			>
				<label class="invite-label" for="invite-email-input">
					Invite by email
				</label>
				<div class="invite-row">
					<input
						id="invite-email-input"
						type="email"
						placeholder="name@example.com"
						bind:value={inviteEmail}
						disabled={inviteSubmitting}
						autocomplete="email"
					/>
					<select
						bind:value={inviteRole}
						disabled={inviteSubmitting}
						aria-label="Role"
					>
						{#each ASSIGNABLE_ACCOUNT_ROLES as r (r)}
							<option value={r}>{ROLE_LABELS[r]}</option>
						{/each}
					</select>
					<button
						type="submit"
						class="primary"
						disabled={inviteSubmitting || !inviteEmail.trim()}
					>
						{inviteSubmitting ? 'Sending…' : 'Send invite'}
					</button>
				</div>
				{#if inviteLocalError}
					<p class="error" role="alert">{inviteLocalError}</p>
				{/if}
				{#if inviteSentAt}
					<p class="saved" role="status">
						Invitation sent. It'll appear under "Pending
						invitations" shortly. Server-side rejections
						(rate limit, already a member, …) surface as
						toasts.
					</p>
				{/if}
			</form>
		{/if}
	</section>

	{#if canManage}
		<section>
			<h2>Pending invitations</h2>
			{#if pendingInviteRows.length === 0}
				<p class="hint">
					No invitations are currently pending. Once you send
					one, it'll appear here until the recipient accepts
					it or you revoke it.
				</p>
			{:else}
				<ul class="account-list">
					{#each pendingInviteRows as invite (`${invite.identity_kind}|${invite.identity_value}`)}
						{@const key = `${invite.identity_kind}|${invite.identity_value}`}
						{@const isExpired =
							invite.time_expires <
							Math.floor(Date.now() / 1000)}
						<li>
							<span class="account-id">
								<code>{invite.identity_value}</code>
								<span class="role-badge">
									{ROLE_LABELS[invite.role] ?? invite.role}
								</span>
								<span
									class="expiry"
									class:expired={isExpired}
								>
									{expiryLabel(invite.time_expires)}
								</span>
							</span>
							<span class="placeholder-cell"></span>
							<button
								type="button"
								class="remove"
								disabled={revoking.has(key)}
								onclick={() => revoke(invite)}
							>
								{revoking.has(key) ? 'Revoking…' : 'Revoke'}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if revokeError}
				<p class="error" role="alert">{revokeError}</p>
			{/if}
		</section>
	{/if}

	{#if errorMsg}
		<p class="error" role="alert">{errorMsg}</p>
	{/if}
	{#if savedAt && !isDirty}
		<p class="saved" role="status">Saved.</p>
	{/if}

	{#if canManage}
		<footer>
			<button
				type="button"
				class="primary"
				disabled={!isDirty || saving}
				onclick={save}
			>
				{saving ? 'Saving…' : 'Save changes'}
			</button>
			<button
				type="button"
				disabled={!isDirty || saving}
				onclick={reset}
			>
				Discard
			</button>
		</footer>
	{/if}
</main>

{#if pendingDemotion}
	<div class="modal-backdrop" role="dialog" aria-modal="true">
		<div class="modal">
			<h3>Lose your manage access?</h3>
			<p>
				You're currently <strong>{pendingDemotion.fromRole}</strong> on
				this {entityType}. After saving, your role will be
				{#if pendingDemotion.toRole}
					<strong>{pendingDemotion.toRole}</strong> and you
				{:else}
					removed and you
				{/if}
				won't be able to manage sharing anymore.
			</p>
			<p>
				Another owner or admin can restore your role; if
				there isn't one, you'll need to recover access through
				support.
			</p>
			<div class="modal-actions">
				<button type="button" onclick={cancelDemotion}>
					Cancel
				</button>
				<button type="button" class="danger" onclick={confirmDemotion}>
					Yes, save anyway
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	main {
		max-width: 42rem;
		margin: 2rem auto;
		padding: 0 1rem;
	}
	header {
		margin-bottom: 1.5rem;
	}
	.back {
		display: inline-block;
		margin-bottom: 0.5rem;
		text-decoration: none;
		opacity: 0.7;
	}
	.back:hover {
		opacity: 1;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.25rem 0;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem 0;
	}
	.entity-name {
		opacity: 0.7;
		margin: 0;
	}
	section {
		margin: 1.5rem 0;
		padding: 1rem;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 0.5rem;
	}
	.hint {
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
		opacity: 0.7;
	}
	.role-options {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.role-options label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		border-radius: 0.25rem;
		cursor: pointer;
	}
	.role-options label:hover {
		background: rgba(0, 0, 0, 0.04);
	}
	.role-options label.selected {
		background: rgba(0, 100, 200, 0.08);
	}
	.url-row {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.url-row input {
		flex: 1;
		padding: 0.4rem 0.6rem;
		font-family: monospace;
		border: 1px solid rgba(0, 0, 0, 0.18);
		border-radius: 0.25rem;
	}
	.account-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.account-list li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0;
		border-bottom: 1px solid rgba(0, 0, 0, 0.06);
	}
	.account-list li:last-child {
		border-bottom: none;
	}
	.account-id code {
		font-size: 0.8rem;
		word-break: break-all;
	}
	.me-badge {
		margin-left: 0.4rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(0, 100, 200, 0.12);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.role-badge {
		margin-left: 0.4rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.06);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.expiry {
		margin-left: 0.4rem;
		font-size: 0.75rem;
		opacity: 0.6;
	}
	.expiry.expired {
		color: rgb(160, 0, 0);
		opacity: 1;
	}
	.placeholder-cell {
		display: inline-block;
	}
	.invite-form {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
	}
	.invite-label {
		display: block;
		font-size: 0.9rem;
		margin-bottom: 0.4rem;
		font-weight: 500;
	}
	.invite-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.5rem;
		align-items: center;
	}
	.invite-row input[type='email'] {
		padding: 0.4rem 0.6rem;
		border: 1px solid rgba(0, 0, 0, 0.18);
		border-radius: 0.25rem;
		font-size: 0.95rem;
	}
	.invite-row select {
		padding: 0.4rem;
		border-radius: 0.25rem;
	}
	.remove {
		background: transparent;
		border: 1px solid rgba(200, 0, 0, 0.3);
		color: rgb(160, 0, 0);
		border-radius: 0.25rem;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}
	.remove:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	footer {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	button {
		padding: 0.5rem 1rem;
		border-radius: 0.25rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		background: white;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button.primary {
		background: rgb(0, 100, 200);
		color: white;
		border-color: rgb(0, 100, 200);
	}
	button.primary:disabled {
		background: rgba(0, 100, 200, 0.4);
	}
	button.danger {
		background: rgb(180, 30, 30);
		color: white;
		border-color: rgb(180, 30, 30);
	}
	.notice {
		padding: 0.5rem 0.75rem;
		background: rgba(255, 180, 0, 0.12);
		border-left: 3px solid rgb(200, 140, 0);
		border-radius: 0.25rem;
		font-size: 0.9rem;
	}
	.error {
		color: rgb(160, 0, 0);
		margin: 0.5rem 0;
	}
	.saved {
		color: rgb(0, 120, 60);
		margin: 0.5rem 0;
	}
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: grid;
		place-items: center;
		z-index: 100;
	}
	.modal {
		background: white;
		padding: 1.5rem;
		border-radius: 0.5rem;
		max-width: 30rem;
		margin: 0 1rem;
	}
	.modal h3 {
		margin: 0 0 0.5rem 0;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
