/**
 * Length of the random suffix we generate, e.g. `ts5V_Qj_Qa0CiYe5d51e`.
 */
export const ID_LENGTH = 21;

/**
 * 64-char URL-safe alphabet — the same character set `nanoid`'s
 * `urlAlphabet` draws from (A-Z, a-z, 0-9, `-`, `_`). The order differs
 * from nanoid's, but the *set* is identical, so IDs minted before this
 * module dropped nanoid still match {@link ID_SUFFIX_RE}.
 */
const URL_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Cryptographically-random string of `length` chars from
 * {@link URL_ALPHABET}, via Web Crypto (`crypto.getRandomValues`).
 *
 * Portable across the browser, Cloudflare Workers, and Node 18+ — no
 * `nanoid` dependency and, deliberately, no Node `crypto`/`Buffer` (which
 * would break the browser and Worker targets this module is shared with).
 *
 * The alphabet has 64 chars — a power of two — so masking each random
 * byte with `& 63` is perfectly uniform: no modulo bias, no rejection
 * sampling needed. Safe for security tokens, not just IDs.
 */
export function randomString(length: number): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) {
        // `byte & 63` is always 0..63 — always within the 64-char alphabet.
        out += URL_ALPHABET[byte & 63]!;
    }
    return out;
}

export const IdTypes = {
    account: 'a',
    group: 'g',
    invitation: 'inv',
    item: 'i',
    list: 'l',
    mutation: 'm',
    session: 's',
    template: 't',
    workspace: 'w',
} as const;

export type IdType = keyof typeof IdTypes;

// Does this work?? Woah...
export type DjibbId = `${IdType}/${string}`;

/**
 * Creates a randomly generated ID with a prefix for the given ID Type.
 */
export function newId<T extends IdType>(
    idType: T
): `${(typeof IdTypes)[T]}/${string}` {
    return `${IdTypes[idType]}/${randomString(ID_LENGTH)}`;
}

// TODO: create a schema for validating keys,
// as well as to pull the type and the id from the full key, so:
//   parseFunc("l/123myid");
//   // returns tuple ["list", "123myid"] or something typed

const PrefixToIdType: Record<string, IdType> = Object.entries(IdTypes).reduce(
    (acc, [key, value]) => {
        acc[value] = key as IdType;
        return acc;
    },
    {} as Record<string, IdType>
);

/**
 * Matches the suffix portion of an ID we generate: ID_LENGTH chars
 * drawn from {@link URL_ALPHABET} (A-Z, a-z, 0-9, `_`, `-`).
 */
const ID_SUFFIX_RE = new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}$`);

/**
 * Parses a key like "l/abc123..." and returns a typed result if valid.
 * Returns `null` if the prefix is unknown or the suffix doesn't look
 * like an ID we'd have minted.
 */
export function parseKey(key: string): [IdType, string] | null {
    const [prefix, id] = key.split('/', 2);

    if (!prefix || !id) return null;

    const type = PrefixToIdType[prefix];
    if (!type) return null;

    if (!ID_SUFFIX_RE.test(id)) return null;

    return [type, id];
}
