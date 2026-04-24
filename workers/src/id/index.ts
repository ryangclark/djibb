import { customAlphabet, urlAlphabet } from 'nanoid';

/**
 * Length of the IDs we generate with `nanoid`, e.g.
 * `ts5V_Qj_Qa0CiYe5d51e`.
 */
export const ID_LENGTH = 21;

export const IdTypes = {
    account: 'a',
    group: 'g',
    item: 'i',
    list: 'l',
    mutation: 'm',
    session: 's',
    workspace: 'w',
};

export type IdType = keyof typeof IdTypes;

let idGenerator: (size?: number) => string;

// Does this work?? Woah...
export type DjibbId = `${IdType}/${string}`;

/**
 * Creates a randomly generated ID with a prefix for the given ID Type.
 */
export function newId(idType: IdType): string {
    // Enables reuse of the generator. I think this works.
    if (idGenerator === undefined) {
        idGenerator = customAlphabet(urlAlphabet, ID_LENGTH);
    }

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
 * Parses an key like "l/abc123" and returns a typed result if valid.
 */
export function parseKey(key: string): [IdType, string] | null {
    const [prefix, id] = key.split('/', 2);

    if (!prefix) return null;

    const type = PrefixToIdType[prefix];
    if (!type || !id) return null;

    return [type, id];
}
