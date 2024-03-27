/**
 * Length of the IDs we generate with `nanoid`, e.g.
 * `ts5V_Qj_Qa0CiYeu5d51e`.
 */
export const LIST_ID_LENGTH = 21;

export const LIST_ELEMENT_TYPES = {
	GROUP: 'group',
	ITEM: 'item',
	LIST: 'list',
};

export const REF_LIST = '_this';

export const URL_SEGMENT_ACTION = 'action';
export const URL_SEGMENT_LIST_ID = 'listId';
export const URL_SEGMENT_SLUG = 'slug';

/**
 * LOL JUST USE THIS LIBRARY https://github.com/convert-units/convert-units/tree/main
 *
 *
 * Unit represents standard units. We'll use UN/CEFACT Common Code
 * (3 characters).
 * @see https://unece.org/fileadmin/DAM/cefact/recommendations/rec20/rec20_rev3_Annex3e.pdf
 *
 * Those are mostly metric units, however; 'tablespoon' isn't
 * included. So just note non-standard ones along the way, and we'll
 * figure it out as we go.
 *
 * Going to need to figure out how to represent the user-friendly
 * equivalents to the codes (e.g. `TBSP` to `Tablespoon`).
 *
 * This is a neat way to make a type out of the keys of an object, like
 * our `Unit` object below. I guess `enum` does that, too, though? Hmm.
 * I'm still learning all this TypeScript stuff.
 *
 *      type foo = keyof typeof Unit;
 */
// export enum Unit {
// 	BOOLEAN = 'BOOL', // not standard
// 	ONZ = 'ONZ', // ounce (weight)
// 	OZA = 'OZA', // fluid ounce (US)
// 	TBSP = 'TBSP', // tablespoon (not standard)
// 	TSP = 'TSP', // teaspoon (not standard)
// }
