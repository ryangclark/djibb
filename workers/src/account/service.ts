import { OAUTH_PROVIDER } from '../auth/constants';
import { ParseError, UnexpectedError } from '../errors';
import { AccountSchema, type Account } from './index';
import { newId } from '../id';

// @TODO: need to handle creating default assets for a new account,
// such as its private workspace.
export async function CreateAccount(d1: D1Database, account: Account) {
    const parseResult = AccountSchema.safeParse(account);

    if (!parseResult.success) {
        console.error('`CreateAccount()` parse error:', parseResult.error);
        throw new ParseError();
    }

    // Set creation values.
    account.id = newId('account');
    account.time_created = new Date();
    account.time_deleted = null;
    account.time_updated = account.time_created;

    return d1
        .prepare(
            `INSERT INTO accounts (
                id,
                display_name,
                email,
                email_verified,
                flags,
                image,
                provider_name,
                provider_client_id,
                time_created,
                time_updated,
                user_name
            ) VALUES (${new Array(11).fill('?').join(', ')})`
        )
        .bind(
            account.id,
            account.display_name,
            account.email,
            account.email_verified,
            account.flags,
            account.image,
            account.provider_name,
            account.provider_client_id,
            Math.floor(account.time_created.getTime() / 1000),
            Math.floor(account.time_updated.getTime() / 1000),
            account.user_name
        )
        .run()
        .then(() => account)
        .catch(err => {
            console.error('`CreateAccount()` insert error:', err);
            throw err;
        });
}

export async function GetAccountById(d1: D1Database, id: string) {
    return d1
        .prepare(`SELECT * FROM accounts WHERE id = ? LIMIT 1;`)
        .bind(id)
        .first()
        .catch(err => {
            console.error('`GetAccountByID()` query error:', err);
            throw new UnexpectedError();
        })
        .then(shape_AccountRow);
}

export async function GetAccountByGoogleId(
    d1: D1Database,
    providerClientId: string
): Promise<Account | null> {
    if (!providerClientId) {
        throw new Error(
            '`GetAccountByGoogleId()` error: invalid `providerClientId`!'
        );
    }

    return d1
        .prepare(
            `SELECT *
            FROM accounts
            WHERE provider_name = ?
                AND provider_client_id = ?
            LIMIT 1;`
        )
        .bind(OAUTH_PROVIDER.enum.google, providerClientId)
        .first()
        .catch(err => {
            console.error('`GetAccountByGoogleId()` query error:', err);
            throw err;
        })
        .then(shape_AccountRow);
}

function shape_AccountRow(row: any): Account | null {
    if (!row) return null;

    const account = {
        id: row.id,
        display_name: row.display_name,
        email: row.email,
        email_verified: row.email_verified,
        flags: row.flags ? JSON.parse(row.flags) : null,
        image: row.image,
        provider_name: row.provider_name,
        provider_client_id: row.provider_client_id,
        time_created: new Date(row.time_created * 1000),
        time_deleted: row.account_time_deleted
            ? new Date(row.account_time_deleted * 1000)
            : null,
        time_updated: new Date(row.time_updated * 1000),
        user_name: row.user_name,
    };

    // Parse via zod to help ensure nothing's broken/omitted in shaping.
    const parseResult = AccountSchema.safeParse(account);

    if (!parseResult.success) {
        console.error(
            '`shape_AccountRow()` parse error:',
            parseResult.error.format(),
            'row:',
            row
        );

        throw new ParseError();
    }

    return parseResult.data;
}
