import { z } from 'zod';
import { createDate, isWithinExpirationDate } from 'oslo';

import { SESSION_EXPIRATION } from './constants';
import { ParseError, UnexpectedError } from '@djibb/protocol/errors';
import { DatelikeToDateSchema } from '@djibb/protocol/schema';
import { AccountSchema, type Account } from '@djibb/protocol/account';
import { newId } from '@djibb/protocol/id';
import { accountFromRow } from './account-row';

/**
 * Attributes that are optional to a session.
 *
 * NOTE: you *can* overwrite fields here – use caution!
 */
export const SessionAttributesSchema = z.object({
    accounts: z.array(AccountSchema).readonly(),
    ip_country: z.string().optional(),
});

export type SessionAttributes = z.TypeOf<typeof SessionAttributesSchema>;

export const SessionSchema = SessionAttributesSchema.extend({
    fresh: z.boolean(),
    id: z.string(),
    time_created: DatelikeToDateSchema,
    time_expires: DatelikeToDateSchema,
});

export type Session = z.TypeOf<typeof SessionSchema>;

export type DatabaseSession = {
    id: string;
    time_created: number;
    time_expires: number;
} & SessionAttributes;

/**
 * Creates a new user session.
 *
 * If you provide a Session ID, we merge the given `attributes` with
 * those of the existing session, then delete that session.
 */
export async function CreateSession(
    d1: D1Database,
    attributes: SessionAttributes,
    fromSessionId?: string
) {
    const session: Session = {
        fresh: true,
        id: newId('session'),
        time_created: new Date(),
        time_expires: createDate(SESSION_EXPIRATION),
        ...attributes,
    };

    const preparedStatements: Array<D1PreparedStatement> = [];

    if (fromSessionId) {
        // Pull existing session to copy its info to new session.
        try {
            const databaseSession = await GetSessionById(d1, fromSessionId);

            if (databaseSession) {
                // Add each account to an object to handle any duplicates.
                const accounts: Record<string, Account> = {};

                for (const account of databaseSession.accounts) {
                    accounts[account.id] = account;
                }
                for (const account of attributes.accounts) {
                    accounts[account.id] = account;
                }

                session.accounts = Object.values(accounts);
            }
        } catch (error) {
            throw new UnexpectedError();
        }

        // First, delete the AccountSession relationships.
        preparedStatements.push(prep_DeleteAccountSession(d1, fromSessionId));

        // Next, delete the Session itself.
        preparedStatements.push(prep_DeleteSession(d1, fromSessionId));
    }

    if (!attributes.accounts.length) {
        throw new Error('`CreateSession()` error: invalid `accounts`!');
    }

    const sessionInsert = d1
        .prepare(
            `INSERT INTO sessions (
                id,
                ip_country,
                time_created,
                time_expires
            ) VALUES (?, ?, ?, ?)`
        )
        .bind(
            session.id,
            attributes.ip_country,
            Math.floor(session.time_created.getTime() / 1000),
            Math.floor(session.time_expires.getTime() / 1000)
        );

    preparedStatements.push(sessionInsert);

    // Create the query to insert relationships between the session
    // and its authorized accounts.
    const bindings = [];
    const placeholders = new Array(session.accounts.length)
        .fill(`(?, ?)`)
        .join(', ');

    // Need to create column pairs for each insertion.
    for (const account of session.accounts) {
        bindings.push(account.id, session.id);
    }

    const relationshipInsert = d1
        .prepare(
            `INSERT INTO AccountSession (
                account_id,
                session_id
            ) VALUES ${placeholders}`
        )
        .bind(...bindings);

    preparedStatements.push(relationshipInsert);

    try {
        // Batched statements are SQL transactions: if any statement
        // fails, the whole sequence aborts and rolls back.
        await d1.batch(preparedStatements);
    } catch (error: any) {
        console.error(
            '`CreateSession()` batch query error:',
            error?.message || error
        );
        throw new UnexpectedError();
    }

    return session;
}

/**
 * Returns a prepared-and-bound statement to delete a Session.
 */
export function prep_DeleteSession(d1: D1Database, sessionId: string) {
    return d1.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId);
}

/**
 * Returns a prepared-and-bound statement to delete Account-Session
 * relationships.
 *
 * NOTE: This query should be executed prior to any query to delete
 * the given Session to avoid foreign-key constraints.
 */
export function prep_DeleteAccountSession(d1: D1Database, sessionId: string) {
    return d1
        .prepare('DELETE FROM AccountSession WHERE session_id = ?')
        .bind(sessionId);
}

/**
 * Runs query to delete the Session with the given ID in the DB.
 */
export function DeleteSession(d1: D1Database, sessionId: string) {
    const stmts = [
        prep_DeleteAccountSession(d1, sessionId),
        prep_DeleteSession(d1, sessionId),
    ];

    return d1
        .batch(stmts)
        .then(batchQueryResults => {
            return batchQueryResults.every(queryResult => queryResult.success);
        })
        .catch(err => {
            console.error('`DeleteSession()` query error:', err);
            throw new UnexpectedError();
        });
}

// TODO: change this function to not use a `batch` of querires, and
// instead just send a single `JOIN` query, and loop over those rows.
//
// OH, and just `JOIN` to pull the account data, too, while we're at
// it – it doesn't make sense to only send Account IDs.
export async function GetSessionById(
    d1: D1Database,
    sessionId: string
): Promise<Session | null> {
    let queryResults;

    try {
        queryResults = await d1
            .prepare(
                `SELECT
                    accounts.id AS account_id,
                    accounts.display_name,
                    accounts.email,
                    accounts.email_verified,
                    accounts.flags,
                    accounts.image,
                    accounts.provider_name,
                    accounts.provider_client_id,
                    accounts.time_created AS account_time_created,
                    accounts.time_deleted AS account_time_deleted,
                    accounts.time_updated AS account_time_updated,
                    accounts.user_name,
                    sessions.id AS session_id,
                    sessions.ip_country,
                    sessions.time_created AS session_time_created,
                    sessions.time_expires AS session_time_expires
                FROM accounts
                JOIN AccountSession
                    ON AccountSession.account_id = accounts.id
                JOIN sessions
                    ON sessions.id = AccountSession.session_id
                WHERE AccountSession.session_id = ?;`
            )
            .bind(sessionId)
            .all();
    } catch (error: any) {
        console.error(
            '`GetSessionById()` query error:',
            error?.message || error
        );
        throw new UnexpectedError();
    }

    if (!queryResults.results.length) {
        return null;
    }

    // Process query results.
    const accounts: Array<Account> = [];
    let session: any = { accounts: accounts, fresh: false };

    for (const row of queryResults.results as any) {
        if (row.account_id) {
            // Single accounts-join-row → Account mapper, shared with the
            // bearer-credential path (`accountFromRow`). One place to map
            // a `accounts` row; neither auth path can drift from the other.
            accounts.push(accountFromRow(row));
        }

        // Only need to set these once.
        if (!session.id) {
            session.id = row.session_id;
            session.ip_country = row.ip_country;
            session.time_created = new Date(row.session_time_created * 1000);
            session.time_expires = new Date(row.session_time_expires * 1000);
        }
    }

    const parseResult = SessionSchema.safeParse(session);

    if (!parseResult.success) {
        console.error(
            '`GetSessionById()` parse error:',
            // Log the `issues` only, stringifying the `path` array.
            ...parseResult.error.issues.map(issue => ({
                ...issue,
                path: issue.path.join('/'),
            }))
        );

        throw new ParseError();
    }

    return parseResult.data;
}

function updateSessionExpiration(
    d1: D1Database,
    { sessionId, time_expires }: { sessionId: string; time_expires: Date }
) {
    return d1
        .prepare('UPDATE sessions SET time_expires = ? WHERE id = ?')
        .bind(Math.floor(time_expires.getTime() / 1000), sessionId)
        .run()
        .then(result => result.meta.changed_db)
        .catch(err => {
            console.error('`updateSessionExpiration()` query error:', err);
            throw err;
        });
}

export async function ValidateSession(d1: D1Database, sessionId: string) {
    const databaseSession = await GetSessionById(d1, sessionId);

    // If no session, return null
    if (!databaseSession) {
        return null;
    }

    // Check session expiration
    if (!isWithinExpirationDate(databaseSession.time_expires)) {
        try {
            await DeleteSession(d1, databaseSession.id);
        } catch (error) {
            console.error(
                '`ValidateSession()` error deleting expired session: "%s"',
                databaseSession.id
            );
            throw new UnexpectedError();
        }

        return null;
    }

    // The session we'll return.
    const session: Session = {
        accounts: databaseSession.accounts,
        fresh: false,
        id: databaseSession.id,
        ip_country: databaseSession.ip_country,
        time_created: databaseSession.time_created,
        time_expires: databaseSession.time_expires,
    };

    // Calculate session refresh point, which is half the full
    // expiration time.
    const refreshDate = new Date(
        databaseSession.time_expires.getTime() -
            SESSION_EXPIRATION.milliseconds() / 2
    );

    // Refresh session, if within refresh cutoff.
    if (!isWithinExpirationDate(refreshDate)) {
        session.fresh = true;
        session.time_expires = createDate(SESSION_EXPIRATION);

        try {
            await updateSessionExpiration(d1, {
                sessionId: databaseSession.id,
                time_expires: session.time_expires,
            });
        } catch (error) {
            console.error(
                '`ValidateSession()` error updating session expiration:',
                error
            );
            throw new UnexpectedError();
        }
    }

    return session;
}
