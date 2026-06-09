// Round-trip + example tests for the Markdown <-> List content encoding
// (ADR 0012). Pure: no DO, no `cloudflare:test` env — just the encoder.
//
// The headline property is the inverse relationship between
// `encodeMarkdown` and `parseMarkdown`. Because the encoder emits a single
// canonical spelling and the parser is more lenient, the clean statements
// are:
//
//   parse(encode(model))            deep-equals  model          (canonical models)
//   encode(parse(encode(model)))    ===          encode(model)  (canonical fixpoint)
//
// We also check the lossy projection from a real DO bundle preserves content,
// and that wild (non-canonical) input imports sensibly.

import { describe, it, expect } from 'vitest';

import {
    encodeMarkdown,
    parseMarkdown,
    listToMarkdown,
    listToModel,
    type MarkdownItem,
    type MarkdownList,
} from '../src/list/markdown';
import type { List, ListGroup, ListItem } from '../src/list/index';

// --- fixtures --------------------------------------------------------------

const recipe: MarkdownList = {
    type: 'list',
    name: 'Weeknight Roast Chicken',
    description: 'A fast one-pan roast.',
    children: [
        {
            kind: 'group',
            name: 'Ingredients',
            items: [
                bool('Chicken — skip the brine', false),
                count('Salt', 0, 2, 'tsp'),
                count('Olive oil', 2, 2, 'tbsp'), // complete -> [x]
            ],
        },
        {
            kind: 'group',
            name: 'Method',
            description: 'Sequential.',
            items: [bool('Preheat oven to 425°F', true), bool('Pat chicken dry', false)],
        },
    ],
};

const templateWithFrontmatter: MarkdownList = {
    type: 'template',
    name: 'Pre-Flight Checklist',
    slug: 'pre-flight',
    forked_from: 't/aaaaaaaaaaaaaaaaaaaaa',
    children: [
        bool('Cabin pressure nominal', false),
        count('Fuel', 3, 10, 'gal'), // partial -> [ ], M/N
    ],
};

const ungroupedOnly: MarkdownList = {
    type: 'list',
    name: 'Things to notice on a walk',
    children: [bool('A color you have no name for', false), bool('A sound that stops', true)],
};

const allFixtures: Array<[string, MarkdownList]> = [
    ['recipe (groups + descriptions)', recipe],
    ['template (frontmatter + lineage)', templateWithFrontmatter],
    ['ungrouped items only', ungroupedOnly],
];

// --- the satisfying part ---------------------------------------------------

describe('round-trip: parse ∘ encode === identity (canonical models)', () => {
    for (const [label, model] of allFixtures) {
        it(label, () => {
            expect(parseMarkdown(encodeMarkdown(model))).toEqual(model);
        });
    }
});

describe('round-trip: encode is a fixpoint through parse', () => {
    for (const [label, model] of allFixtures) {
        it(label, () => {
            const once = encodeMarkdown(model);
            expect(encodeMarkdown(parseMarkdown(once))).toBe(once);
        });
    }
});

// --- canonical spelling ----------------------------------------------------

describe('canonical encoding', () => {
    it('omits frontmatter for a plain List with no slug/lineage', () => {
        expect(encodeMarkdown(ungroupedOnly).startsWith('# ')).toBe(true);
    });

    it('emits frontmatter for a Template / when slug or lineage present', () => {
        const md = encodeMarkdown(templateWithFrontmatter);
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toContain('djibb: template');
        expect(md).toContain('slug: pre-flight');
        expect(md).toContain('forked_from: t/aaaaaaaaaaaaaaaaaaaaa');
    });

    it('checkbox reflects universal completion (value === target)', () => {
        const md = encodeMarkdown(recipe);
        expect(md).toContain('- [x] Olive oil — 2/2 tbsp'); // value===target
        expect(md).toContain('- [ ] Salt — 0/2 tsp'); // fresh count: 0/N, slash mandatory
        expect(md).toContain('- [x] Preheat oven to 425°F'); // boolean done
        expect(md).toContain('- [ ] Pat chicken dry');
    });
});

// --- lenient import (wild input) ------------------------------------------

describe('lenient import of non-canonical Markdown', () => {
    it('accepts plain "-" bullets as unchecked booleans', () => {
        const model = parseMarkdown('# Groceries\n\n- Milk\n- Eggs\n');
        expect(model.children).toEqual([
            bool('Milk', false),
            bool('Eggs', false),
        ]);
    });

    it('reads a slash count with the value explicit (box advisory)', () => {
        const model = parseMarkdown('# X\n- [ ] Water — 8/8 cups\n');
        expect(model.children[0]).toEqual(count('Water', 8, 8, 'cups'));
    });

    it('treats a slash-less "N unit" tail as a name, not a count', () => {
        // The bare `N unit` shorthand is retired (ADR 0012 §C): no slash,
        // no count, so the whole text stays the item name (boolean).
        const model = parseMarkdown('# X\n- [ ] Rest — 5 min\n');
        expect(model.children[0]).toEqual(bool('Rest — 5 min', false));
    });

    it('parses without frontmatter as a plain List', () => {
        expect(parseMarkdown('# Hi\n').type).toBe('list');
    });
});

// --- documented sharp edges (surfaced by dogfooding) ----------------------

describe('known limitations / sharp edges (ADR 0012)', () => {
    // Edge 1: an em dash inside an item NAME must not be mistaken for the
    // ` — quantity ` separator. Parsing is grammar-driven, so a boolean
    // item's em dash (no quantity grammar follows) stays in the name.
    it('preserves an em dash inside a boolean item name', () => {
        const model: MarkdownList = {
            type: 'list',
            name: 'X',
            children: [bool('Chicken — skip the brine', false)],
        };
        expect(parseMarkdown(encodeMarkdown(model))).toEqual(model);
    });

    // Edge 2: a `##` heading is terminal in Markdown. An ungrouped item that
    // comes AFTER a group in the model cannot be represented — it folds into
    // the preceding group on the way back. We assert the lossy behavior so
    // the limitation is visible and intentional, not a silent surprise.
    it('folds an ungrouped item that follows a group into that group', () => {
        const md = '# X\n\n## Section\n- [ ] Inside\n\n- [ ] MeantToBeLoose\n';
        const model = parseMarkdown(md);
        expect(model.children).toHaveLength(1);
        const group0 = model.children[0];
        expect(group0?.kind).toBe('group');
        if (group0?.kind === 'group') {
            expect(group0.items.map((i: MarkdownItem) => i.name)).toEqual([
                'Inside',
                'MeantToBeLoose',
            ]);
        }
    });
});

// --- projection from a real DO bundle -------------------------------------

describe('listToModel / listToMarkdown projection', () => {
    it('resolves order from child_element_refs and nests group items', () => {
        // Loose item BEFORE the group: representable in Markdown (a `##`
        // heading is terminal, so ungrouped items must precede the first
        // group to survive — see the limitation test below).
        const list = entity('l/' + 'a'.repeat(21), ['i/loose', 'g/g1']);
        const loose = item('i/loose', 'Loose', 0, 1, 'boolean');
        const g1 = group('g/g1', 'Section', ['i/a', 'i/b']);
        const ia = item('i/a', 'Alpha', 1, 1, 'boolean');
        const ib = item('i/b', 'Beta', 0, 3, 'cups');

        const model = listToModel(list, [loose, g1, ia, ib]);
        expect(model.name).toBe('My List');
        expect(model.children).toEqual([
            { kind: 'item', name: 'Loose', quantity: { value: 0, target_value: 1, unit: 'boolean' } },
            {
                kind: 'group',
                name: 'Section',
                items: [
                    { kind: 'item', name: 'Alpha', quantity: { value: 1, target_value: 1, unit: 'boolean' } },
                    { kind: 'item', name: 'Beta', quantity: { value: 0, target_value: 3, unit: 'cups' } },
                ],
            },
        ]);

        // And the projection -> string -> model preserves content.
        expect(parseMarkdown(listToMarkdown(list, [loose, g1, ia, ib]))).toEqual(model);
    });

    it('skips dangling child_element_refs', () => {
        const list = entity('l/' + 'a'.repeat(21), ['i/missing', 'i/real']);
        const real = item('i/real', 'Real', 0, 1, 'boolean');
        expect(listToModel(list, [real]).children).toEqual([
            { kind: 'item', name: 'Real', quantity: { value: 0, target_value: 1, unit: 'boolean' } },
        ]);
    });
});

// --- tiny builders ---------------------------------------------------------

function bool(name: string, checked: boolean): MarkdownItem {
    return {
        kind: 'item',
        name,
        quantity: { value: checked ? 1 : 0, target_value: 1, unit: 'boolean' },
    };
}

function count(name: string, value: number, target: number, unit: string): MarkdownItem {
    return { kind: 'item', name, quantity: { value, target_value: target, unit } };
}

function entity(id: string, childRefs: string[]): List {
    return {
        id,
        type: 'list',
        name: 'My List',
        authorization_rules: { default_role: 'ownerless', authorized_accounts: [] } as never,
        cascade_source: null,
        child_element_refs: childRefs,
        forked_from_id: null,
        meta: null,
        slot: null,
        time_created: new Date(0),
        time_deleted: null,
        time_updated: new Date(0),
        workspace_id: null,
        version: 1,
    };
}

function group(id: string, name: string, childRefs: string[]): ListGroup {
    return {
        id,
        type: 'group',
        name,
        parent_element_ref: 'l/' + 'a'.repeat(21),
        child_element_refs: childRefs,
        time_created: new Date(0),
        time_deleted: null,
        time_updated: new Date(0),
        version: 1,
    };
}

function item(
    id: string,
    name: string,
    value: number,
    target: number,
    unit: string
): ListItem {
    return {
        id,
        type: 'item',
        name,
        parent_element_ref: 'l/' + 'a'.repeat(21),
        references_entity_id: null,
        value: { value, target_value: target, unit },
        time_created: new Date(0),
        time_deleted: null,
        time_updated: new Date(0),
        version: 1,
    };
}
