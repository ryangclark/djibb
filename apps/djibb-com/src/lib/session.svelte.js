import { getContext, setContext } from 'svelte';
import { fetchWorkspacesForAccount } from '$lib/api/workspace';
import { api, DjibbHttpError } from '$lib/api/client';

export const STATUSES = {
	idle: 'idle',
	loading: 'loading'
};

const SESSION_KEY = Symbol('SESSION');
const ACTIVE_WORKSPACE_KEY = 'djibb.activeWorkspaceSlug';

/**
 * @returns {SessionState}
 */
export function getSessionState() {
	return getContext(SESSION_KEY);
}

export function setSessionState() {
	return setContext(SESSION_KEY, new SessionState());
}

class SessionState {
	/** @type {readonly import("@djibb/protocol/account").Account[]} */
	accounts = $state([]);
	/** @type {string|null} */
	currentAccountId = $state(null);
	/** @type {string} active workspace slug */
	currentWorkspaceSlug = $state('');
	/** @type {import('$lib/api/workspace').WorkspaceWithMembership[]} */
	workspaces = $state([]);
	error = $state();
	status = $state(STATUSES.idle);
	/**
	 * Flips true after the first fetchSession completes (success OR
	 * unauthenticated). Page-level effects that depend on
	 * `currentAccountId` should gate on this — otherwise they fire
	 * with `currentAccountId === null` during the brief window
	 * between mount and session-resolve. For entity routes
	 * (/l/[id], /t/[id], and their /share children) firing too early
	 * means `initList()` pushes an ownerless entity with
	 * `accountId: null` before the real account is known.
	 */
	hasLoaded = $state(false);

	/** Guards against overlapping revalidations (focus + visibilitychange
	 * can both fire on a single tab switch). */
	#revalidating = false;

	async fetchSession() {
		if (this.status !== STATUSES.idle) {
			console.warn(
				'`SessionState.fetchSession()` error: state must be `idle` to fetch'
			);
			return;
		}

		this.status = STATUSES.loading;

		try {
			const session = /** @type {{ accounts: any[] }} */ (
				await api.get('/auth/session')
			);
			this.error = undefined;
			this.accounts = session.accounts;
			await this.refreshWorkspaces();
		} catch (err) {
			// 401 is "signed out" — a normal resting state, not an error.
			if (err instanceof DjibbHttpError && err.status === 401) {
				this.accounts = [];
				this.workspaces = [];
				this.error = undefined;
				this.status = STATUSES.idle;
				this.hasLoaded = true;
				return;
			}
			this.error = err;
			this.accounts = [];
			this.workspaces = [];
		}

		this.status = STATUSES.idle;
		this.hasLoaded = true;
	}

	async refreshWorkspaces() {
		if (!this.accounts.length) {
			this.workspaces = [];
			return;
		}
		const results = await Promise.all(
			this.accounts.map((a) => fetchWorkspacesForAccount(a.id).catch(() => []))
		);
		this.workspaces = results.flat();

		// Restore previously selected workspace if still valid; otherwise
		// default to the first workspace's slug.
		const stored =
			typeof localStorage !== 'undefined'
				? localStorage.getItem(ACTIVE_WORKSPACE_KEY)
				: null;
		const validSlugs = new Set(this.workspaces.map((w) => w.workspace.slug));
		if (stored && validSlugs.has(stored)) {
			this.setActiveWorkspace(stored, { persist: false });
		} else if (this.workspaces.length) {
			this.setActiveWorkspace(this.workspaces[0].workspace.slug);
		}
	}

	/**
	 * Re-fetch the membership-backed workspace list and re-hydrate the
	 * switcher without disturbing the active selection. Closes the
	 * staleness window while a tab is open — an invite, rename, or
	 * removal that lands elsewhere shows up on the next focus. Also safe
	 * to call after the actor's own membership-changing actions (create
	 * workspace, accept invite, leave). No-op until the first session
	 * load completes. See ADR 0013 (revalidate the existing fetch; no
	 * DO, no CVR, no poke).
	 */
	async revalidateWorkspaces() {
		if (!this.hasLoaded || !this.accounts.length || this.#revalidating) return;
		this.#revalidating = true;
		try {
			await this.refreshWorkspaces();
		} finally {
			this.#revalidating = false;
		}
	}

	/**
	 * Pick a workspace as active. Auto-resolves the active account to the
	 * one whose membership grants access (the doc's "auto-resolve active
	 * account" behavior).
	 *
	 * @param {string} slug
	 * @param {{ persist?: boolean }} [opts]
	 */
	setActiveWorkspace(slug, opts = {}) {
		const { persist = true } = opts;
		const match = this.workspaces.find((w) => w.workspace.slug === slug);
		if (!match) return;
		this.currentWorkspaceSlug = slug;
		this.currentAccountId = match.membership.account_id;
		if (persist && typeof localStorage !== 'undefined') {
			localStorage.setItem(ACTIVE_WORKSPACE_KEY, slug);
		}
	}

	/**
	 * Can this account be made the current one right now?
	 *
	 * "Current account" is not directly settable — it is *derived* from
	 * the active workspace (`setActiveWorkspace`, above), so an account is
	 * only reachable if the session can see a workspace it's a member of.
	 * Being signed in is necessary but not sufficient. Callers that offer
	 * "switch to that account" as an action (the stranded-work banner, GH
	 * #46) must ask before offering, or the button is a lie.
	 *
	 * @param {string} accountId
	 */
	canSwitchToAccount(accountId) {
		return this.workspaces.some((w) => w.membership.account_id === accountId);
	}

	/**
	 * Make `accountId` the current account by activating a workspace it
	 * belongs to. Returns false when there is no such workspace — the
	 * caller must not assume it worked (see `canSwitchToAccount`).
	 *
	 * @param {string} accountId
	 * @returns {boolean}
	 */
	switchToAccount(accountId) {
		const match = this.workspaces.find(
			(w) => w.membership.account_id === accountId
		);
		if (!match) return false;
		this.setActiveWorkspace(match.workspace.slug);
		return true;
	}

	/**
	 * The active workspace's entity id (the `workspace_id` a freshly
	 * created list/template should be stamped with), resolved from the
	 * active slug. `null` until a workspace is selected — a new entity
	 * created in that window is workspace-less, same as before. Derived
	 * rather than stored alongside the slug so the two can't drift.
	 * @returns {string | null}
	 */
	get currentWorkspaceId() {
		const match = this.workspaces.find(
			(w) => w.workspace.slug === this.currentWorkspaceSlug
		);
		return match?.workspace.id ?? null;
	}
}
