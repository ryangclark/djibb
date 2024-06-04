import { z } from 'zod';

export const EmailAddressSchema = z.object({
    email_address: z.string().email(),
    verified: z.date().nullable(),
});

export const AccountSchema = z.object({
    display_name: z.string(),
    email_addresses: z.array(EmailAddressSchema),
    id: z.string(),
    image: z.string().nullable(),
    time_created: z.string().datetime(),
    time_deleted: z.string().datetime().nullable(),
    time_updated: z.string().datetime(),
});

const AccountIdentifierTypes = z.enum(['email', 'phone', 'username']);

export type AccountIdentifier = z.infer<typeof AccountIdentifierTypes>;

/**
 * Based on Clerk's way of doing things, an Account has an Identifier
 * to make it identifiable. The identifier comes from an outside source
 * and is unique to a User (a User might have several Accounts, tho).
 *
 * An identifier is an email address, phone number, or username.
 *
 * I haven't decided which to use yet... Can add support for the others
 * later on.
 *
 * https://clerk.com/docs/authentication/configuration/sign-up-sign-in-options#identifiers
 */
const AccountIdentifier = z.object({
    identifier: z.string(), // could validate this field further, depending on the `type`.
    type: AccountIdentifierTypes,
});
