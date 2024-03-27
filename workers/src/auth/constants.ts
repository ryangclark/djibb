export const COOKIE_NAME_SESSION_ID = 'session_id';
export const DURABLE_OBJECT_NAME_AUTH = '_djibb_auth';

/**
 * "Relying Party" refers to the website that is trying to ascertain
 * and verify the identity of the user or perform FIDO authentication.
 *
 * Essentially, the Relying Party is this server.
 *
 * The RP is how we'll represent the site to the Authenticator, which
 * is the device providing auth credentials (e.g. a smartphone).
 */

/**
 * Start by defining some constants that describe your "Relying Party"
 * (RP) server to authenticators.
 *
 * These will be referenced throughout registrations and authentications
 * to ensure that authenticators generate and return credentials
 * specifically for your server.
 */

// Human-readable title for the website.
export const RELYING_PARTY_NAME = 'djibb authentication';

// A unique identifier for your website.
// I don't know what this should be.
export const RELYING_PARTY_ID = 'localhost';

// The URL at which registrations and authentications should occur
// export const origin = `https://${rpID}`;
