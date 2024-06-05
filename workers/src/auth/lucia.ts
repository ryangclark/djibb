import { Lucia } from 'lucia';
import { D1Adapter } from '@lucia-auth/adapter-sqlite';

// Cloudflare provides the D1 binding with each request, so we create
// a new Lucia instance on every request.
export function initializeLucia(D1: D1Database) {
    const adapter = new D1Adapter(D1, {
        // Table names that Lucia needs.
        user: 'users',
        session: 'sessions',
    });
    return new Lucia(adapter, {
        getSessionAttributes(databaseSessionAttributes) {
            return {
                // Not sure yet how this will work if the db column is empty/null.
                accountIds: JSON.parse(databaseSessionAttributes.account_ids),
                activeAccountId: databaseSessionAttributes.active_account_id,
                // Not sure if I should make this a `new Date()` or just leave it.
                createdAt: databaseSessionAttributes.created_at,
                expiresAt: databaseSessionAttributes.expires_at,
                ipCountry: databaseSessionAttributes.ip_country,
            };
        },
    });
}

declare module 'lucia' {
    interface Register {
        Lucia: ReturnType<typeof initializeLucia>;
        DatabaseSessionAttributes: DatabaseSessionAttributes;
    }
    // TODO: ensure these fields are all in the DB migrations.
    interface DatabaseSessionAttributes {
        account_ids: string; // `JSON.stringify()` of the array of Account IDs.
        active_account_id: string | null;
        created_at: number;
        expires_at: number;
        ip_country: string; // keeping this from example bc it seems interesting
    }
}
