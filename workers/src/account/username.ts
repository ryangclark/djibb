import { BadRequestError, FailedPreconditionError, NotFoundError, UnexpectedError } from '../errors';
import { RESERVED_SLUGS } from '../list/slug';

/**
 * Username format: lowercase letter to start, then letters, digits,
 * underscores, or hyphens. 3–30 chars total. Stored lowercased on
 * write so case-insensitive uniqueness collapses to a plain `=`.
 */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,29}$/;

/**
 * Reserved usernames — every reserved slug (spread directly from
 * `list/slug.ts::RESERVED_SLUGS` so the two namespaces can't drift)
 * plus username-only shadow-words. Add slug/route reservations there;
 * add username-only ones to the list below.
 */
const RESERVED_USERNAMES = new Set([
    ...RESERVED_SLUGS,
    // Username-specific shadow-words:
    'staff',
    'null',
    'undefined',
    'me',
    'you',
    'self',
    'system',
    'djibb',
    'root',
]);

export function normalizeUsername(raw: string): string {
    return raw.trim().toLowerCase();
}

export function assertUsernameFormat(name: string): void {
    if (!USERNAME_PATTERN.test(name)) {
        throw new BadRequestError(
            'Invalid username: must start with a letter, then letters, digits, hyphens, or underscores (3–30 chars).'
        );
    }
    if (RESERVED_USERNAMES.has(name)) {
        throw new BadRequestError(`Username "${name}" is reserved.`);
    }
}

/**
 * Set or change an account's username. Caller is responsible for
 * verifying the actor owns the account (i.e., it appears in their
 * session). Stored lowercased; uniqueness is enforced by the DB index.
 */
export async function SetAccountUsername(
    d1: D1Database,
    accountId: string,
    rawUsername: string
): Promise<string> {
    const username = normalizeUsername(rawUsername);
    assertUsernameFormat(username);

    try {
        const result = await d1
            .prepare(
                `UPDATE accounts SET user_name = ?, time_updated = ?
                 WHERE id = ?`
            )
            .bind(username, Math.floor(Date.now() / 1000), accountId)
            .run();
        if (!result.meta.changes) throw new NotFoundError('Account not found.');
    } catch (err: any) {
        if (err instanceof NotFoundError) throw err;
        if (String(err?.message ?? '').includes('UNIQUE')) {
            throw new FailedPreconditionError('Username already taken.');
        }
        console.error('SetAccountUsername error:', err);
        throw new UnexpectedError();
    }

    return username;
}

export async function GetAccountByUsername(
    d1: D1Database,
    rawUsername: string
): Promise<{ id: string; display_name: string; image: string | null } | null> {
    const username = normalizeUsername(rawUsername);
    if (!USERNAME_PATTERN.test(username)) return null;

    const row = await d1
        .prepare(
            `SELECT id, display_name, image FROM accounts
             WHERE user_name = ? COLLATE NOCASE
                AND time_deleted IS NULL
             LIMIT 1`
        )
        .bind(username)
        .first<{ id: string; display_name: string; image: string | null }>();
    return row ?? null;
}
