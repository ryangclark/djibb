<script>
	import { SvelteSet } from 'svelte/reactivity';

	// THROWAWAY PROTOTYPE — GH #19 (ADR 0022 §6, "the access surface is the
	// grant-axes union, rendered by a client"). Its job is to settle the
	// per-row FIELD set and the ACTION inventory before #4/#5 build the
	// powering data layer and #6b builds the real surface. Delete this route
	// once those land — nothing here is wired to live data.
	//
	// Everything below is hardcoded mock state. The three row TYPES that
	// "what's connected" unions:
	//   1. session — an interactive sign-in (sessions/AccountSession §4). No
	//      token, no binding; Revoke == sign that browser out.
	//   2. token   — an issued_credentials bearer token (§4). Nameable,
	//      bound-able, expirable, revocable; the CLI is the first one.
	//   3. bot     — a non-human Account that is itself a member row (§3).
	//      Operates its OWN Account, so it shows up via the roster, not the
	//      credentials substrate; Revoke == remove the member.
	//
	// The point of the prototype is to look at all three side by side and
	// decide which columns survive into the real projection. Findings get
	// written to docs/plans/connected-clients-surface.md.

	/** @param {number} mins minutes ago */
	function ago(mins) {
		if (mins < 60) return `${mins}m ago`;
		if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
		return `${Math.round(mins / (60 * 24))}d ago`;
	}

	/**
	 * @typedef {Object} Row
	 * @property {string} id
	 * @property {'session'|'token'|'bot'} type
	 * @property {string} label        what a human reads first
	 * @property {string} actsAs       the Account this acts as (id suffix)
	 * @property {string|null} bound   bound_entity_id, or null (unbound)
	 * @property {number} lastUsedMins
	 * @property {number} createdDays
	 * @property {number|null} expiresDays  null == non-expiring (revoke-only)
	 * @property {'active'|'revoked'|'expired'} state
	 */

	/** @type {Row[]} */
	const allRows = [
		{
			id: 's1',
			type: 'session',
			label: 'Chrome · macOS',
			actsAs: 'Ryan',
			bound: null,
			lastUsedMins: 2,
			createdDays: 0,
			expiresDays: 14,
			state: 'active'
		},
		{
			id: 's2',
			type: 'session',
			label: 'Safari · iPhone',
			actsAs: 'Ryan',
			bound: null,
			lastUsedMins: 60 * 5,
			createdDays: 3,
			expiresDays: 14,
			state: 'active'
		},
		{
			id: 't1',
			type: 'token',
			label: "Ryan's laptop CLI",
			actsAs: 'Ryan',
			bound: null,
			lastUsedMins: 60,
			createdDays: 30,
			expiresDays: null,
			state: 'active'
		},
		{
			id: 't2',
			type: 'token',
			label: 'groceries import script',
			actsAs: 'Ryan',
			bound: 'l/groceries-aaaaaaaaa',
			lastUsedMins: 60 * 26,
			createdDays: 7,
			expiresDays: 60,
			state: 'active'
		},
		{
			id: 'b1',
			type: 'bot',
			label: 'email-reply bot',
			actsAs: 'email-reply bot',
			bound: null,
			lastUsedMins: 60 * 24 * 3,
			createdDays: 90,
			expiresDays: null,
			state: 'active'
		}
	];

	/** @type {Row[]} */
	const historyRows = [
		{
			id: 't9',
			type: 'token',
			label: 'old CI token',
			actsAs: 'Ryan',
			bound: 'l/groceries-aaaaaaaaa',
			lastUsedMins: 60 * 24 * 40,
			createdDays: 120,
			expiresDays: 0,
			state: 'expired'
		},
		{
			id: 't8',
			type: 'token',
			label: 'leaked laptop CLI (rotated)',
			actsAs: 'Ryan',
			bound: null,
			lastUsedMins: 60 * 24 * 55,
			createdDays: 200,
			expiresDays: null,
			state: 'revoked'
		}
	];

	// Mutation-log attribution (§5): each entry renders WHAT acted, not just
	// which Account. A token entry reads "via <label>"; a plain session
	// entry just reads the Account.
	const mutationLog = [
		{ action: 'Renamed the list', via: "Ryan's laptop CLI", who: 'Ryan', mins: 60 },
		{ action: 'Added 12 items', via: 'groceries import script', who: 'Ryan', mins: 60 * 26 },
		{ action: 'Checked off an item', via: null, who: 'Ryan', mins: 60 * 27 },
		{ action: 'Replied with an item', via: 'email-reply bot', who: 'email-reply bot', mins: 60 * 24 * 3 }
	];

	let showHistory = $state(false);

	// Local-only revoke: marks the row revoked in mock state so the button
	// behavior is clickable. No network, no persistence.
	const revoked = new SvelteSet();

	/** @param {Row} r */
	function onRevoke(r) {
		const verb = r.type === 'bot' ? 'Remove this bot member?' : 'Revoke this?';
		if (!confirm(verb)) return;
		revoked.add(r.id);
	}

	const TYPE_BADGE = {
		session: 'bg-sky-100 text-sky-800',
		token: 'bg-violet-100 text-violet-800',
		bot: 'bg-amber-100 text-amber-800'
	};

	/** @param {Row} r */
	function rowState(r) {
		return revoked.has(r.id) ? 'revoked' : r.state;
	}
</script>

<section class="max-w-3xl">
	<p class="text-xs text-amber-700 mb-1">
		⚠ Throwaway prototype (GH #19) — mock data, nothing is wired. Decides the
		field/button set for #4/#5/#6b, then gets deleted.
	</p>
	<h1 class="text-xl mb-1">Connected clients</h1>
	<p class="text-sm text-stone-500 mb-4">
		Everything that can act on this workspace — active sign-ins, issued
		tokens, and bot members — in one roster.
	</p>

	<table class="text-sm w-full mb-2">
		<thead>
			<tr class="text-stone-500 text-left align-bottom">
				<th class="pr-4 pb-1">Client</th>
				<th class="pr-4 pb-1">Acts as</th>
				<th class="pr-4 pb-1">Scope</th>
				<th class="pr-4 pb-1">Last used</th>
				<th class="pr-4 pb-1">Created</th>
				<th class="pr-4 pb-1">Expires</th>
				<th class="pb-1"></th>
			</tr>
		</thead>
		<tbody class="divide-y">
			{#each allRows as r (r.id)}
				{@const st = rowState(r)}
				<tr class={st === 'revoked' ? 'text-stone-400 line-through' : ''}>
					<td class="pr-4 py-2">
						<span
							class="inline-block rounded px-1.5 py-0.5 text-xs mr-2 no-underline {TYPE_BADGE[
								r.type
							]}">{r.type}</span
						>{r.label}
					</td>
					<td class="pr-4 py-2">{r.actsAs}</td>
					<td class="pr-4 py-2">
						{#if r.bound}
							<span class="font-mono text-xs">{r.bound}</span>
						{:else}
							<span class="text-stone-400">whole account</span>
						{/if}
					</td>
					<td class="pr-4 py-2 whitespace-nowrap">{ago(r.lastUsedMins)}</td>
					<td class="pr-4 py-2 whitespace-nowrap">{ago(r.createdDays * 60 * 24)}</td>
					<td class="pr-4 py-2 whitespace-nowrap">
						{#if r.type === 'bot'}
							<span class="text-stone-400">—</span>
						{:else if r.expiresDays == null}
							<span class="text-stone-400">never</span>
						{:else}
							in {r.expiresDays}d
						{/if}
					</td>
					<td class="py-2 text-right">
						{#if st === 'revoked'}
							<span class="text-xs text-stone-400 no-underline">revoked</span>
						{:else}
							<button class="text-red-600 text-xs" onclick={() => onRevoke(r)}>
								{r.type === 'bot' ? 'Remove' : 'Revoke'}
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<button
		class="text-xs text-stone-500 underline mb-6"
		onclick={() => (showHistory = !showHistory)}
	>
		{showHistory ? '▾' : '▸'} Credential history (revoked / expired) — {historyRows.length}
	</button>

	{#if showHistory}
		<table class="text-sm w-full mb-6 text-stone-400">
			<tbody class="divide-y">
				{#each historyRows as r (r.id)}
					<tr>
						<td class="pr-4 py-2">
							<span
								class="inline-block rounded px-1.5 py-0.5 text-xs mr-2 {TYPE_BADGE[
									r.type
								]}">{r.type}</span
							>{r.label}
						</td>
						<td class="pr-4 py-2">{r.actsAs}</td>
						<td class="pr-4 py-2 whitespace-nowrap">last {ago(r.lastUsedMins)}</td>
						<td class="py-2 text-right text-xs uppercase">{r.state}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<h2 class="text-lg mb-2">Recent activity</h2>
	<p class="text-sm text-stone-500 mb-2">
		How credential attribution reads inline (§5): a token entry shows
		<em>via &lt;label&gt;</em>, a plain sign-in just shows the Account.
	</p>
	<ul class="text-sm divide-y">
		{#each mutationLog as m, i (i)}
			<li class="py-2 flex items-baseline gap-3">
				<span>
					<strong>{m.who}</strong>
					{m.action}
					{#if m.via}
						<span class="text-stone-500">· via {m.via}</span>
					{/if}
				</span>
				<span class="text-xs text-stone-500 ml-auto whitespace-nowrap"
					>{ago(m.mins)}</span
				>
			</li>
		{/each}
	</ul>
</section>
