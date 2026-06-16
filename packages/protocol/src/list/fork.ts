import type { Quantity } from './index';

/**
 * Server-authoritative fork verification (Phase 1b of the Minted List
 * hybrid copy). `mintFromBlank` writes the Blank's groups/items *inline*
 * from the client (optimistic, client-chosen ids); before that server
 * write runs, a `_handlePush` preflight reads the real Blank DO and
 * checks the submitted content faithfully matches it. Match -> proceed;
 * mismatch -> skip-and-ack. This is what keeps `forked_from_id`
 * authoritative for content-at-birth without the server having to
 * re-assign ids (which would churn the optimistic rows).
 *
 * The comparison is over an **id-independent content signature**: two
 * trees with the same group/item content and structure hash to the same
 * string regardless of element ids, timestamps, or versions — so the
 * freshly-minted List (new ids) compares equal to the Blank it forks.
 */

/** Field separator — a control char that cannot appear in user-entered text. */
const SEP = '';

interface SigGroup {
    name: string;
    description?: string;
    child_element_refs: readonly string[];
}
interface SigItem {
    name: string;
    description?: string;
    value: Quantity;
}

/**
 * Canonicalize a Quantity to a stable string. Fixed key order; optional
 * bounds are emitted only when present so an absent `min_value` on both
 * sides doesn't perturb the signature. Content fields only — a Blank's
 * pre-set item `value` is content (CONTEXT.md §"Default state via
 * Template item values"), so it participates.
 */
function canonicalQuantity(q: Quantity): string {
    const parts = [
        `unit=${q.unit}`,
        `value=${q.value}`,
        `target=${q.target_value}`,
    ];
    if (q.min_value !== undefined) parts.push(`min=${q.min_value}`);
    if (q.max_value !== undefined) parts.push(`max=${q.max_value}`);
    return parts.join(',');
}

/**
 * Build the canonical signature by walking `childElementRefs` in order:
 * each ref is a group (emit it, then its items in the group's own child
 * order) or a loose item. Elements not reachable from `childElementRefs`
 * are deliberately ignored — they aren't part of the visible tree, which
 * is exactly what `forked_from_id` attests to.
 */
export function forkContentSignature(input: {
    childElementRefs: readonly string[];
    groupsById: ReadonlyMap<string, SigGroup>;
    itemsById: ReadonlyMap<string, SigItem>;
}): string {
    const { childElementRefs, groupsById, itemsById } = input;
    const lines: string[] = [];

    const emitItem = (item: SigItem) => {
        lines.push(
            ['I', item.name, item.description ?? '', canonicalQuantity(item.value)].join(SEP)
        );
    };

    for (const ref of childElementRefs) {
        const group = groupsById.get(ref);
        if (group) {
            lines.push(['G', group.name, group.description ?? ''].join(SEP));
            for (const childRef of group.child_element_refs) {
                const item = itemsById.get(childRef);
                if (item) emitItem(item);
            }
            continue;
        }
        const item = itemsById.get(ref);
        if (item) emitItem(item);
    }

    return lines.join('\n');
}

/**
 * Build the signature from a `mintFromBlank` mutation's *raw* (not yet
 * argsSchema-validated) args, defensively. Returns `null` when the args
 * are structurally malformed — the preflight then defers to the
 * mutator's own argsSchema to reject, rather than guessing.
 */
export function mintArgsSignature(rawArgs: Record<string, unknown>): string | null {
    const { childElementRefs, groups, items } = rawArgs;
    if (!Array.isArray(childElementRefs) || !Array.isArray(groups) || !Array.isArray(items)) {
        return null;
    }
    if (!childElementRefs.every(r => typeof r === 'string')) return null;

    const groupsById = new Map<string, SigGroup>();
    for (const g of groups) {
        if (!g || typeof g !== 'object') return null;
        const gg = g as Record<string, unknown>;
        if (
            typeof gg.id !== 'string' ||
            typeof gg.name !== 'string' ||
            !Array.isArray(gg.child_element_refs)
        ) {
            return null;
        }
        groupsById.set(gg.id, {
            name: gg.name,
            description: typeof gg.description === 'string' ? gg.description : undefined,
            child_element_refs: gg.child_element_refs.filter(
                (r): r is string => typeof r === 'string'
            ),
        });
    }

    const itemsById = new Map<string, SigItem>();
    for (const it of items) {
        if (!it || typeof it !== 'object') return null;
        const ii = it as Record<string, unknown>;
        if (
            typeof ii.id !== 'string' ||
            typeof ii.name !== 'string' ||
            !ii.value ||
            typeof ii.value !== 'object'
        ) {
            return null;
        }
        itemsById.set(ii.id, {
            name: ii.name,
            description: typeof ii.description === 'string' ? ii.description : undefined,
            value: ii.value as Quantity,
        });
    }

    return forkContentSignature({
        childElementRefs: childElementRefs as string[],
        groupsById,
        itemsById,
    });
}
