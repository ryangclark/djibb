const BASE = import.meta.env.VITE_API_BASE_URL;

/**
 * @param {string} accountId Full prefixed ID, e.g. "a/0Hb...".
 * @param {string} userName
 * @returns {Promise<{ id: string, user_name: string, detail: string }>}
 */
export async function setAccountUsername(accountId, userName) {
	const res = await fetch(`${BASE}/${accountId}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			'X-Djibb-Active-Account': accountId
		},
		body: JSON.stringify({ user_name: userName })
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} username
 * @returns {Promise<{ id: string, display_name: string, image: string|null }|null>}
 */
export async function lookupUsername(username) {
	const res = await fetch(`${BASE}/u/${encodeURIComponent(username)}`, {
		credentials: 'include'
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}
