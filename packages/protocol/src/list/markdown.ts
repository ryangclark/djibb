/**
 * Markdown <-> List content encoding (ADR 0012).
 *
 * djibb exposes a List at two fidelity levels:
 *
 *  - **JSON** is the canonical, *lossless* encoding — it carries identity
 *    and machinery (`id`, `version`, timestamps, `authorization_rules`,
 *    `references_entity_id`, `slot`, the `child_element_refs` DAG). It is
 *    the DO state, filtered; it round-trips an *entity*.
 *  - **Markdown** is a *lossy*, content-only encoding — structure, names,
 *    descriptions, check-state, and quantities. It round-trips the
 *    *content*, not the entity. Identity, auth, and references are dropped
 *    (JSON-only in v1). This is the "copy as markdown", "paste from a NASA
 *    checklist", and "hand an agent a List" surface.
 *
 * This module is the Markdown half. It is deliberately dependency-free and
 * pure (no DO, no Zod, no nanoid) so the round-trip property — the inverse
 * relationship between {@link encodeMarkdown} and {@link parseMarkdown} —
 * can be tested in total isolation (see `test/markdown.test.ts`, and the
 * pure-predicate convention in `docs/testing.md`).
 *
 * The content model below ({@link MarkdownList}) is the lossy projection.
 * {@link listToMarkdown} adapts a real DO bundle (entity + elements) down
 * to a string; the reverse, wiring a parsed model back into a DO via
 * `initList` + element mutators, is the *consumer's* job (it needs fresh
 * IDs and auth context this module has no business minting) and is left to
 * the worker route / import path.
 */

import type { List, ListGroup, ListItem, Template } from './index';

// ---------------------------------------------------------------------------
// Content model — the lossy projection of a List.
// ---------------------------------------------------------------------------

/** The content of a {@link ListItem}'s `Quantity`, without bounds. */
export interface MarkdownQuantity {
    value: number;
    target_value: number;
    unit: string;
}

export interface MarkdownItem {
    kind: 'item';
    name: string;
    description?: string;
    quantity: MarkdownQuantity;
}

/**
 * PROTOTYPE (Fix 0 / ADR-0012 §F): a subgroup *within* a group — the WHO
 * Surgical Safety list's `### Anticipated Critical Events` and its bold role
 * labels (`**To Surgeon:**`). A section is a labelled bucket of items; the
 * `kind` discriminant is reserved for the eventual nested-group model (B).
 * In the content model sections nest under a group; the *DO mapping* is the
 * consumer's call — C flattens section items into the group (the label is a
 * divider, not a parent), B would mint real nested groups.
 */
export interface MarkdownSection {
    kind: 'section';
    name: string;
    description?: string;
    items: MarkdownItem[];
}

export interface MarkdownGroup {
    kind: 'group';
    name: string;
    description?: string;
    /** Direct items, before any section. Canonically: items precede sections. */
    items: MarkdownItem[];
    /** Subgroups; present only when the group has at least one. */
    sections?: MarkdownSection[];
}

/** A direct child of the List: an ungrouped item or a group. */
export type MarkdownChild = MarkdownGroup | MarkdownItem;

export interface MarkdownList {
    /** `list` is the default; `template` only when the frontmatter says so. */
    type: 'list' | 'template';
    name: string;
    description?: string;
    /** Lossless extras, surfaced in YAML frontmatter when present. */
    slug?: string;
    forked_from?: string;
    children: MarkdownChild[];
}

const BOOLEAN_UNIT = 'boolean';
/** ` — ` — em dash with single spaces, separating an item name from its quantity. */
const QTY_SEP = ' — ';

// ---------------------------------------------------------------------------
// Encode: MarkdownList -> string (canonical).
// ---------------------------------------------------------------------------

/**
 * Render a {@link MarkdownList} to canonical GitHub-flavored Markdown.
 *
 * Canonical means: this is the *one* spelling {@link parseMarkdown} will
 * reproduce on the way back, so `encode(parse(encode(x))) === encode(x)`.
 * The parser is more lenient than the encoder is (it accepts plain `-`
 * bullets, missing frontmatter, etc.) — that asymmetry is what lets wild
 * input (a pasted checklist) come in, while our own output stays stable.
 */
export function encodeMarkdown(list: MarkdownList): string {
    const out: string[] = [];

    const fm = encodeFrontmatter(list);
    if (fm) out.push(fm, '');

    out.push(`# ${list.name}`);
    if (list.description) out.push('', list.description);

    for (const child of list.children) {
        out.push('');
        if (child.kind === 'group') {
            out.push(`## ${child.name}`);
            if (child.description) out.push('', child.description);
            for (const item of child.items) {
                out.push(...encodeItem(item));
            }
            // PROTOTYPE (Fix 0 / §F): subgroups canonicalize to `###`, even
            // when the input wrote them as bold labels. An empty section is
            // still emitted (a bare `###`) so the round-trip is a fixpoint.
            for (const section of child.sections ?? []) {
                out.push('', `### ${section.name}`);
                if (section.description) out.push('', section.description);
                for (const item of section.items) {
                    out.push(...encodeItem(item));
                }
            }
        } else {
            out.push(...encodeItem(child));
        }
    }

    // Single trailing newline; no leading blank line.
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Frontmatter is emitted only when there is something lossless to carry:
 * a Template type, a slug, or a lineage pointer. A plain List with none of
 * these encodes to headings-and-bullets with no `---` fence — which is
 * exactly what a human pasting a checklist expects, and keeps the canonical
 * form minimal.
 */
function encodeFrontmatter(list: MarkdownList): string | null {
    const lines: string[] = [];
    if (list.type === 'template') lines.push('djibb: template');
    if (list.slug) lines.push(`slug: ${list.slug}`);
    if (list.forked_from) lines.push(`forked_from: ${list.forked_from}`);
    if (lines.length === 0) return null;
    return ['---', ...lines, '---'].join('\n');
}

function encodeItem(item: MarkdownItem): string[] {
    const { value, target_value } = item.quantity;
    // Completion is universal (CONTEXT.md): an item is done when
    // value === target_value, checkbox or count alike.
    const box = value === target_value ? '[x]' : '[ ]';
    const suffix = encodeQuantity(item.quantity);
    const lines = [`- ${box} ${item.name}${suffix}`];
    if (item.description) {
        // Indent each description line two spaces so GFM folds it into the
        // list item as a continuation paragraph.
        for (const line of item.description.split('\n')) {
            lines.push(`  ${line}`);
        }
    }
    return lines;
}

/**
 * Quantity spelling (ADR 0012 §C):
 *  - `boolean` -> no suffix; the checkbox *is* the value.
 *  - any count -> ` — M/N unit` (value M, target N). The slash is
 *    mandatory; a fresh count is just ` — 0/N unit`. There is no bare
 *    `N unit` shorthand — a slash always means count, and nothing else does.
 */
function encodeQuantity(q: MarkdownQuantity): string {
    if (q.unit === BOOLEAN_UNIT) return '';
    return `${QTY_SEP}${q.value}/${q.target_value} ${q.unit}`;
}

// ---------------------------------------------------------------------------
// Parse: string -> MarkdownList (lenient).
// ---------------------------------------------------------------------------

const ITEM_RE = /^-\s+(?:\[([ xX])\]\s+)?(.*)$/;
const GROUP_RE = /^##\s+(.*)$/;
const TITLE_RE = /^#\s+(.*)$/;
/** PROTOTYPE (Fix 0 / §F): `###`..`######` open a subgroup (section). */
const SECTION_RE = /^#{3,6}\s+(.*)$/;
/** A line that is *entirely* bold, e.g. `**To Surgeon:**` — a section label. */
const BOLD_LABEL_RE = /^\*\*(.+?)\*\*\s*$/;

/**
 * Parse Markdown into the content model. Lenient by design: accepts plain
 * `-` bullets (treated as unchecked booleans), missing frontmatter, and
 * loose blank-line placement, so a pasted checklist parses without
 * ceremony. On our own canonical output it is the exact inverse of
 * {@link encodeMarkdown}.
 */
export function parseMarkdown(md: string): MarkdownList {
    const { data, body } = splitFrontmatter(md);
    const lines = body.split('\n');

    const list: MarkdownList = {
        type: data.djibb === 'template' ? 'template' : 'list',
        name: '',
        children: [],
    };
    if (typeof data.slug === 'string') list.slug = data.slug;
    if (typeof data.forked_from === 'string') list.forked_from = data.forked_from;

    // Structural cursors. Items land in the innermost open container
    // (section > group > list); prose lands there too — *unless* it's indented
    // under an item, which makes it that item's continuation/description.
    let currentGroup: MarkdownGroup | null = null;
    let currentSection: MarkdownSection | null = null;
    let currentItem: MarkdownItem | null = null;

    const appendDesc = (t: { description?: string }, text: string) => {
        t.description = t.description ? `${t.description}\n${text}` : text;
    };
    /** The innermost open container — what loose prose describes. */
    const container = (): { description?: string } =>
        currentSection ?? currentGroup ?? list;

    for (const raw of lines) {
        const indented = /^\s+\S/.test(raw); // leading whitespace before content
        const line = raw.trim();
        if (line === '') continue;

        if (!list.name) {
            const titleMatch = TITLE_RE.exec(line);
            if (titleMatch) {
                list.name = (titleMatch[1] ?? '').trim();
                currentItem = null;
                continue;
            }
        }

        const groupMatch = GROUP_RE.exec(line);
        if (groupMatch) {
            currentGroup = { kind: 'group', name: (groupMatch[1] ?? '').trim(), items: [] };
            currentSection = null;
            currentItem = null;
            list.children.push(currentGroup);
            continue;
        }

        // PROTOTYPE (Fix 0 / §F): a `###` heading or an all-bold line opens a
        // section, but only inside a group (a section needs a parent). `###`
        // and bold collapse to one section level — the WHO list's h3-then-bold
        // nesting flattens to siblings; B (real nested groups) would keep it.
        if (currentGroup) {
            const sectionMatch = SECTION_RE.exec(line) ?? BOLD_LABEL_RE.exec(line);
            if (sectionMatch) {
                currentSection = { kind: 'section', name: (sectionMatch[1] ?? '').trim(), items: [] };
                currentItem = null;
                (currentGroup.sections ??= []).push(currentSection);
                continue;
            }
        }

        // Top-level bullets only: an *indented* bullet is a sub-item, which
        // this model doesn't have yet — it falls through to item description
        // (deferred to B / conditional subtrees).
        const itemMatch = !indented ? ITEM_RE.exec(line) : null;
        if (itemMatch) {
            currentItem = parseItem(itemMatch[1], itemMatch[2] ?? '');
            (currentSection?.items ?? currentGroup?.items ?? list.children).push(currentItem);
            continue;
        }

        // Prose. Indented under an item -> that item's continuation. Otherwise
        // it describes the innermost open container — never the previous item
        // (Fix 0: a heading/label introduces what *follows*, not what precedes).
        if (indented && currentItem) appendDesc(currentItem, line);
        else appendDesc(container(), line);
    }

    return list;
}

/**
 * Build a single item from its checkbox state and trailing text. The
 * checkbox carries completion; a ` — quantity` tail (if any) carries the
 * count.
 *
 * Parsing is **grammar-driven, not separator-driven**: the tail after the
 * *last* ` — ` is treated as a quantity only if it actually parses as one
 * (`M/N unit` — the slash *and* a unit word are both required). Otherwise
 * the whole text is the name. This is what lets an em dash live *inside* an
 * item name (`Chicken — skip the brine`, `Rest — 5 min`) without being
 * mistaken for a quantity: no slash, no count. The only residual collision
 * is a literal fraction-slash + unit in a name (`Sprint — 3/4 mile` meant as
 * prose) — essentially never written.
 */
function parseItem(box: string | undefined, text: string): MarkdownItem {
    const checked = box === 'x' || box === 'X';

    const sepAt = text.lastIndexOf(QTY_SEP);
    if (sepAt >= 0) {
        const tail = text.slice(sepAt + QTY_SEP.length).trim();
        const quantity = tryParseQuantity(tail, checked);
        if (quantity) {
            return { kind: 'item', name: text.slice(0, sepAt).trim(), quantity };
        }
    }

    // No parseable quantity tail: a boolean checkbox.
    return {
        kind: 'item',
        name: text.trim(),
        quantity: { value: checked ? 1 : 0, target_value: 1, unit: BOOLEAN_UNIT },
    };
}

/**
 * Parse `M/N unit` into a {@link MarkdownQuantity}, or `null` if the text
 * isn't a quantity. Both the slash *and* a unit word are required: `Wait —
 * 5` (no slash, no unit), `Rest — 5 min` (no slash), and `Note — 1/2` (no
 * unit) all fail to register, leaving the text as a plain item name. The
 * value is explicit, so the checkbox is advisory only.
 *
 * The `_checked` argument is unused now that the bare `N unit` shorthand is
 * retired — kept in the signature so the call site stays uniform.
 */
function tryParseQuantity(text: string, _checked: boolean): MarkdownQuantity | null {
    const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(\S.*)$/.exec(text);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;

    return { value: Number(m[1]), target_value: Number(m[2]), unit: m[3].trim() };
}

interface Frontmatter {
    djibb?: string;
    slug?: string;
    forked_from?: string;
    [key: string]: string | string[] | undefined;
}

/**
 * Split a leading `---` ... `---` YAML block off the body. Minimal parser:
 * flat `key: scalar` and `key: [a, b]` lines only — enough for the entity
 * frontmatter, no YAML dependency. Anything richer is the build/import
 * step's concern, not this module's.
 */
function splitFrontmatter(md: string): { data: Frontmatter; body: string } {
    const text = md.replace(/^﻿/, '');
    if (!text.startsWith('---\n')) return { data: {}, body: text };
    const end = text.indexOf('\n---', 4);
    if (end < 0) return { data: {}, body: text };

    const block = text.slice(4, end);
    const rest = text.slice(end + 4).replace(/^\n/, '');
    const data: Frontmatter = {};
    for (const line of block.split('\n')) {
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());
        if (!m || m[1] === undefined) continue;
        const key = m[1];
        const value = (m[2] ?? '').trim();
        if (value.startsWith('[') && value.endsWith(']')) {
            data[key] = value
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        } else {
            data[key] = value.replace(/^['"]|['"]$/g, '');
        }
    }
    return { data, body: rest };
}

// ---------------------------------------------------------------------------
// Projection: a real DO bundle (entity + elements) -> Markdown.
// ---------------------------------------------------------------------------

/**
 * Project a List/Template entity and its elements down to the content
 * model, resolving order from the `child_element_refs` DAG (document order
 * in Markdown *is* the ordering, so this is where it's pinned). Items whose
 * parent is the entity itself are ungrouped; items under a group nest.
 */
export function listToModel(
    entity: List | Template,
    elements: Array<ListGroup | ListItem>
): MarkdownList {
    const byId = new Map<string, ListGroup | ListItem>();
    for (const el of elements) byId.set(el.id, el);

    const toItem = (it: ListItem): MarkdownItem => ({
        kind: 'item',
        name: it.name,
        ...(it.description ? { description: it.description } : {}),
        quantity: {
            value: it.value.value,
            target_value: it.value.target_value,
            unit: it.value.unit,
        },
    });

    const children: MarkdownChild[] = [];
    for (const ref of entity.child_element_refs) {
        const el = byId.get(ref);
        if (!el) continue; // dangling ref — read-time concern, skip.
        if (el.type === 'group') {
            children.push({
                kind: 'group',
                name: el.name,
                ...(el.description ? { description: el.description } : {}),
                items: el.child_element_refs
                    .map(r => byId.get(r))
                    .filter((e): e is ListItem => !!e && e.type === 'item')
                    .map(toItem),
            });
        } else if (el.type === 'item') {
            children.push(toItem(el));
        }
    }

    return {
        type: entity.type,
        name: entity.name,
        ...(entity.description ? { description: entity.description } : {}),
        ...(entity.slug ? { slug: entity.slug } : {}),
        ...(entity.forked_from_id ? { forked_from: entity.forked_from_id } : {}),
        children,
    };
}

/** Convenience: project a DO bundle straight to a Markdown string. */
export function listToMarkdown(
    entity: List | Template,
    elements: Array<ListGroup | ListItem>
): string {
    return encodeMarkdown(listToModel(entity, elements));
}
