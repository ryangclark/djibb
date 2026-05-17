import { customAlphabet, urlAlphabet } from 'nanoid';

/**
 * Length of the IDs we generate with `nanoid`, e.g.
 * `ts5V_Qj_Qa0CiYe5d51e`.
 */
export const ID_LENGTH = 21;

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

const idGenerator = customAlphabet(urlAlphabet, ID_LENGTH);

/**
 * Creates a randomly generated ID with a prefix for the given ID Type.
 */
export function newId<T extends IdType>(
    idType: T
): `${(typeof IdTypes)[T]}/${string}` {
    return `${IdTypes[idType]}/${idGenerator()}`;
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
 * drawn from nanoid's `urlAlphabet` (A-Z, a-z, 0-9, `_`, `-`).
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
