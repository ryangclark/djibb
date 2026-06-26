/**
 * The single accounts-join-row → {@link Account} mapper.
 *
 * Both auth substrates resolve an Account from a row that joins the
 * `accounts` table: `GetSessionById` (`auth/session.ts`) over
 * `sessions ⋈ AccountSession ⋈ accounts`, and `VerifyBearerCredential`
 * (`auth/credential.ts`) over `issued_credentials ⋈ accounts`. Both
 * SELECTs alias the account columns identically (`accounts.id AS
 * account_id`, `accounts.time_created AS account_time_created`, …), so
 * one mapper serves both. This is the one place the row→domain
 * translation lives — a new `accounts` column is added here once, and
 * neither auth path can drift from the other.
 *
 * Neutral home (imported by both substrates) so `session.ts` and
 * `credential.ts` stay peers — neither depends on the other.
 */
import { AccountSchema, type Account } from '@djibb/protocol/account';
import { ParseError } from '@djibb/protocol/errors';

/**
 * Builds an {@link Account} from a join row carrying the aliased account
 * columns. Unix-second timestamps become Dates (×1000); `flags` is
 * JSON-parsed when present. Throws {@link ParseError} if the row doesn't
 * satisfy `AccountSchema`.
 */
export function accountFromRow(row: Record<string, any>): Account {
    const candidate = {
        id: row.account_id,
        display_name: row.display_name,
        email: row.email,
        email_verified: row.email_verified,
        // `AccountSchema.flags` takes the raw JSON string and parses it
        // itself (a Zod transform). Pass the column through untouched —
        // pre-parsing here would hand the schema an object it rejects.
        // (Both original mappers pre-parsed; it never fired only because
        // `flags` is always null in practice — a latent bug fixed by the
        // extraction.)
        flags: row.flags ?? null,
        image: row.image,
        provider_name: row.provider_name,
        provider_client_id: row.provider_client_id,
        time_created: new Date(row.account_time_created * 1000),
        time_deleted: row.account_time_deleted
            ? new Date(row.account_time_deleted * 1000)
            : null,
        time_updated: new Date(row.account_time_updated * 1000),
        user_name: row.user_name,
    };

    const parseResult = AccountSchema.safeParse(candidate);
    if (!parseResult.success) {
        console.error(
            '`accountFromRow()` parse error:',
            ...parseResult.error.issues.map(issue => ({
                ...issue,
                path: issue.path.join('/'),
            })),
        );
        throw new ParseError();
    }

    return parseResult.data;
}
