import { z } from 'zod';

import { DatelikeToDateSchema } from '../schema';
import { OAUTH_PROVIDER } from '../auth/constants';

export const AccountSchema = z.object({
    id: z.string(),
    display_name: z.string(),
    email: z.string().nullable(),
    // Accept both boolean and SQLite's 0/1 int representation.
    email_verified: z
        .union([z.literal(0), z.literal(1), z.boolean()])
        .transform(val => {
            if (val === true || val === false) return val;
            return val === 1;
        }),
    // Per-account bag of settings/flags. Stored as JSON string; parsed
    // to an unknown record here — narrow in call sites that need it.
    flags: z
        .string()
        .nullable()
        .transform(val => {
            if (val === null) return null;
            try {
                return JSON.parse(val) as Record<string, unknown>;
            } catch (e) {
                throw new Error(`Invalid \`flags\` JSON data: ${val}`);
            }
        }),
    image: z.string().nullable(),
    provider_name: OAUTH_PROVIDER,
    provider_client_id: z.string().min(2),
    user_name: z.string().nullable(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
});

export type Account = z.TypeOf<typeof AccountSchema>;
