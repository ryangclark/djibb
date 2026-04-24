import { getContext, setContext } from 'svelte';

export const STATUSES = {
	idle: 'idle',
	loading: 'loading'
};

const SESSION_KEY = Symbol('SESSION');

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
	/** @type {readonly import("$djibb/account").Account[]} */
	accounts = $state([]);
	// Might be nice to sort the IDs by a last-used time?
	// accountIds = $derived(Object.keys(this.accounts));
	currentAccountId = $state(null);
	currentWorkspaceId = $state('');
	error = $state();
	status = $state(STATUSES.idle);

	async fetchSession() {
		if (this.status !== STATUSES.idle) {
			console.warn(
				'`SessionState.fetchSession()` error: state must be `idle` to fetch'
			);
			return;
		}

		this.status = STATUSES.loading;

		try {
			const response = await fetch(
				`${import.meta.env.VITE_API_BASE_URL}/auth/session`,
				{ credentials: 'include' }
			);

			if (response.status === 401) {
				// No session. Return defaults.
				this.accounts = [];
				this.error = undefined;
				this.status = STATUSES.idle;

				return;
			}

			this.error = undefined;
			/** @type {import("$djibb/auth/session").Session} */
			const session = await response.json();

			this.accounts = session.accounts;
		} catch (err) {
			this.error = err;

			// Not sure an error should wipe everything out...
			// Leaving it for now. We'll probably need more granular
			// error handling here anyway once we know the errors.
			this.accounts = [];
		}

		this.status = STATUSES.idle;
	}
}
