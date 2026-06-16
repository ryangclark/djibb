#!/usr/bin/env node
/**
 * `djibb` — the project CLI. v0.1.
 *
 * One subcommand today: `test-parse`, which runs a Markdown file through the
 * ADR-0012 content encoder (`parseMarkdown` <-> `encodeMarkdown`) and checks
 * the two round-trip invariants the module guarantees. This is the
 * dogfooding surface for `seed/contributed/` — a contributed List *is* a test
 * of the system, and this command is how an agent runs that test.
 *
 * Pure and dependency-free, like the module it exercises: it runs under plain
 * `node` via TypeScript type-stripping (Node >= 23.6), no build step.
 *
 *   ./djibb test-parse                 # every list in ./seed/contributed/ (searched upward)
 *   ./djibb test-parse wrong-window    # one seed, by slug
 *   ./djibb test-parse path/to/list.md # one file, by path
 *   ./djibb test-parse wrong-window --show   # also print the canonical form
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';

import { parseMarkdown, encodeMarkdown } from '@djibb/protocol/list/markdown';
import type { MarkdownList } from '@djibb/protocol/list/markdown';

/**
 * The seed/contributed dir of the djibb project we're standing in: walk up
 * from the cwd until we find one. This is what lets a PATH-linked `djibb`
 * act on the *current* project, not the checkout it was installed from.
 */
function findSeedDir(): string {
    let dir = process.cwd();
    for (;;) {
        const candidate = join(dir, 'seed', 'contributed');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        `no seed/contributed/ found from ${process.cwd()} — ` +
            `run inside a djibb project, or pass a file path.`
    );
}

const c = {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};
const PASS = c.green('✓');
const FAIL = c.red('✗');

// ---------------------------------------------------------------------------
// test-parse
// ---------------------------------------------------------------------------

interface FileResult {
    label: string;
    ok: boolean;
    /** Human-readable lines describing what happened. */
    notes: string[];
    /** The canonical Markdown, for `--show`. */
    canonical: string;
}

/** Frontmatter keys the content-only encoder keeps (ADR 0012); the rest is lossy. */
const KEPT_FRONTMATTER = new Set(['djibb', 'slug', 'forked_from']);

/**
 * Run the round-trip on one file. The invariants (mirrored from
 * `test/markdown.test.ts`):
 *   1. model identity:  parse(canonical) deep-equals parse(raw)
 *   2. canonical fixpoint:  encode(parse(canonical)) === canonical
 * Then two informational notes a contributor cares about: which frontmatter
 * fields the lossy encoding drops (expected), and whether the *body* they
 * hand-wrote is already canonical (a real surprise if not).
 */
async function testParseFile(path: string, label: string): Promise<FileResult> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        return { label, ok: false, canonical: '', notes: [c.red(`could not read ${path}: ${(err as Error).message}`)] };
    }

    const model = parseMarkdown(raw);
    const canonical = encodeMarkdown(model);
    const reModel = parseMarkdown(canonical);
    const reCanonical = encodeMarkdown(reModel);

    const identityOk = isDeepStrictEqual(model, reModel);
    const fixpointOk = reCanonical === canonical;
    const ok = identityOk && fixpointOk;

    // Content summary.
    const groups = model.children.filter(ch => ch.kind === 'group');
    const looseItems = model.children.filter(ch => ch.kind === 'item');
    const grouped = groups.reduce((n, g) => n + (g.kind === 'group' ? g.items.length : 0), 0);
    const totalItems = looseItems.length + grouped;
    const extras: string[] = [];
    if (model.slug) extras.push(`slug=${model.slug}`);
    if (model.forked_from) extras.push(`forked_from=${model.forked_from}`);

    const notes: string[] = [
        c.dim(
            `${model.type} "${model.name}" · ${groups.length} group(s) · ` +
                `${totalItems} item(s)${extras.length ? ' · ' + extras.join(' ') : ''}`
        ),
        `${identityOk ? PASS : FAIL} model identity (parse ∘ encode ∘ parse)`,
        `${fixpointOk ? PASS : FAIL} canonical fixpoint (encode is stable)`,
    ];

    if (!model.name) {
        notes.push(c.yellow('⚠ no `# Title` found — list name is empty'));
    }

    // Expected loss: frontmatter fields the content-only encoding drops.
    const { keys: fmKeys, body: rawBody } = splitFrontmatter(raw);
    const dropped = fmKeys.filter(k => !KEPT_FRONTMATTER.has(k));
    if (dropped.length) {
        notes.push(
            c.dim(`• content-only encoding drops frontmatter (expected): ${dropped.join(', ')}`)
        );
    }

    // Real signal: is the hand-written *body* already canonical? Compare it to
    // the canonical output's own body so frontmatter shifts don't pollute the
    // diff.
    const canonBody = splitFrontmatter(canonical).body.trimEnd();
    if (rawBody.trimEnd() === canonBody) {
        notes.push(c.dim('• body is already canonical'));
    } else {
        notes.push(c.yellow('• body would be reformatted — diff:'));
        notes.push(...diff(rawBody.trimEnd() + '\n', canonBody + '\n'));
    }

    return { label, ok, canonical, notes };
}

/**
 * Split a leading `---` ... `---` block off, returning its top-level keys and
 * the remaining body. Mirrors the module's minimal splitter (it isn't
 * exported) just enough to name dropped keys — not a YAML parser.
 */
function splitFrontmatter(md: string): { keys: string[]; body: string } {
    const text = md.replace(/^﻿/, '');
    if (!text.startsWith('---\n')) return { keys: [], body: text };
    const end = text.indexOf('\n---', 4);
    if (end < 0) return { keys: [], body: text };
    const block = text.slice(4, end);
    const body = text.slice(end + 4).replace(/^\n/, '');
    const keys: string[] = [];
    for (const line of block.split('\n')) {
        // Only top-level `key:` lines (column 0); skip folded-scalar continuations.
        const m = /^([A-Za-z0-9_]+):/.exec(line);
        if (m && m[1]) keys.push(m[1]);
    }
    return { keys, body };
}

/** Minimal line diff: `-` raw, `+` canonical, for lines that differ. */
function diff(before: string, after: string): string[] {
    const a = before.split('\n');
    const b = after.split('\n');
    const max = Math.max(a.length, b.length);
    const out: string[] = [];
    for (let i = 0; i < max; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] !== undefined) out.push(c.red(`    - ${a[i]}`));
        if (b[i] !== undefined) out.push(c.green(`    + ${b[i]}`));
    }
    return out.length ? out : [c.dim('    (whitespace only)')];
}

/** Resolve a CLI arg to one or more file paths. */
async function resolveTargets(arg: string | undefined): Promise<Array<{ path: string; label: string }>> {
    if (!arg) {
        // Default: every list in the current project's seed/contributed/, minus README.
        const seedDir = findSeedDir();
        const entries = await readdir(seedDir);
        return entries
            .filter((f: string) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
            .sort()
            .map((f: string) => ({ path: join(seedDir, f), label: f }));
    }

    // An existing path (absolute or relative to cwd) wins.
    const asPath = resolve(process.cwd(), arg);
    if (existsSync(asPath)) return [{ path: asPath, label: arg }];

    // Otherwise treat it as a seed slug, with or without the .md extension.
    const seedDir = findSeedDir();
    const slug = arg.endsWith('.md') ? arg : `${arg}.md`;
    const seedPath = join(seedDir, slug);
    if (existsSync(seedPath)) return [{ path: seedPath, label: slug }];

    throw new Error(`no file at "${arg}", and no seed "${seedPath}"`);
}

/** Render one file's round-trip result — shared by test-parse and contribute. */
function printFileResult(result: FileResult, show: boolean): void {
    const head = result.ok ? PASS : FAIL;
    console.log(`\n${head} ${c.bold(result.label)}`);
    for (const note of result.notes) console.log(`  ${note}`);
    if (show && result.canonical) {
        console.log(c.dim('  ── canonical ──'));
        console.log(result.canonical.replace(/^/gm, '  '));
    }
}

/** Kebab-case a title into a slug: lowercase, non-alnum → '-', collapsed. */
function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

async function cmdTestParse(args: string[]): Promise<number> {
    const show = args.includes('--show');
    const positional = args.filter(a => !a.startsWith('--'));

    let targets: Array<{ path: string; label: string }>;
    try {
        targets = await resolveTargets(positional[0]);
    } catch (err) {
        console.error(c.red((err as Error).message));
        return 1;
    }
    if (targets.length === 0) {
        console.error(c.yellow('nothing to test (no .md files found)'));
        return 1;
    }

    let failed = 0;
    for (const { path, label } of targets) {
        const result = await testParseFile(path, label);
        printFileResult(result, show);
        if (!result.ok) failed++;
    }

    const total = targets.length;
    console.log(`\n${failed === 0 ? PASS : FAIL} ${c.bold(`${total - failed}/${total} passed`)}`);
    return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// contribute
// ---------------------------------------------------------------------------

/**
 * Add an example List to the current project's `seed/contributed/` holding
 * pen (the import side of the homepage Seed Pool), then immediately run it
 * through the same round-trip `test-parse` uses so a contributor sees it land.
 *
 * Source is either an existing file (`--path`) or inline Markdown (`-m`).
 * The slug is resolved flag → frontmatter → kebab-cased `# Title`. Input
 * that already carries frontmatter is written through verbatim (we trust the
 * contributor); input with none gets the holding-pen contract synthesized
 * (`djibb`, `slug`, `contributed_by`, `status: proposed`) so a pasted
 * checklist becomes a valid proposal in one step.
 */
async function cmdContribute(args: string[]): Promise<number> {
    const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const show = args.includes('--show');
    const force = args.includes('--force');
    const path = flag('--path');
    const message = flag('-m') ?? flag('--message');
    const slugFlag = flag('--slug');
    const by = flag('--by') ?? flag('--contributed-by');

    if (!path && !message) {
        console.error(c.red('contribute needs a source: --path <file.md> or -m "<list markdown>"'));
        return 1;
    }
    if (path && message) {
        console.error(c.red('pass only one of --path or -m, not both'));
        return 1;
    }

    // 1. Load the raw Markdown.
    let raw: string;
    if (path) {
        const abs = resolve(process.cwd(), path);
        try {
            raw = await readFile(abs, 'utf8');
        } catch (err) {
            console.error(c.red(`could not read ${abs}: ${(err as Error).message}`));
            return 1;
        }
    } else {
        raw = message as string;
    }

    // 2. Parse to validate and to learn the name / type / embedded slug.
    let model: ReturnType<typeof parseMarkdown>;
    try {
        model = parseMarkdown(raw);
    } catch (err) {
        console.error(c.red(`could not parse the list: ${(err as Error).message}`));
        return 1;
    }

    // 3. Resolve the slug: flag wins, then frontmatter, then the title.
    const slug = slugFlag ?? model.slug ?? slugify(model.name);
    if (!slug) {
        console.error(
            c.red('no slug: pass --slug, add `slug:` frontmatter, or give the list a `# Title`')
        );
        return 1;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        console.error(c.red(`slug "${slug}" is not kebab-case (a–z, 0–9, dashes)`));
        return 1;
    }

    // 4. Build file content. Existing frontmatter is trusted verbatim;
    //    its absence means we synthesize the holding-pen contract.
    const { keys } = splitFrontmatter(raw);
    let content: string;
    if (keys.length === 0) {
        const fm = [
            '---',
            `djibb: ${model.type}`,
            `slug: ${slug}`,
            `contributed_by: ${by ?? 'unknown'}`,
            'status: proposed',
            '---',
            '',
            '',
        ].join('\n');
        content = fm + raw.replace(/^\n+/, '');
    } else {
        content = raw;
        const missing = ['status', 'contributed_by'].filter(k => !keys.includes(k));
        if (missing.length) {
            console.log(c.yellow(`⚠ frontmatter missing recommended: ${missing.join(', ')}`));
        }
        if (model.slug && model.slug !== slug) {
            console.log(c.yellow(`⚠ frontmatter slug "${model.slug}" ≠ filename "${slug}"`));
        }
    }

    // 5. Write into the holding pen (never clobber without --force).
    let seedDir: string;
    try {
        seedDir = findSeedDir();
    } catch (err) {
        console.error(c.red((err as Error).message));
        return 1;
    }
    const dest = join(seedDir, `${slug}.md`);
    if (existsSync(dest) && !force) {
        console.error(c.red(`${slug}.md already exists — pass --force to overwrite`));
        return 1;
    }
    try {
        await writeFile(dest, content.endsWith('\n') ? content : content + '\n', 'utf8');
    } catch (err) {
        console.error(c.red(`could not write ${dest}: ${(err as Error).message}`));
        return 1;
    }
    console.log(`${PASS} wrote ${c.bold(`seed/contributed/${slug}.md`)}`);

    // 6. Dogfood it: same round-trip test-parse runs.
    const result = await testParseFile(dest, `${slug}.md`);
    printFileResult(result, show);
    return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

/**
 * Promote contributed seeds into the live homepage **Seed Pool**
 * (CONTEXT.md §Seed Pool). Each `seed/contributed/*.md` becomes a real
 * **Blank Template** Durable Object (read-only `viewer`), and a
 * referencing item is added to the global Seed Pool **List** so the
 * homepage can rotate through them.
 *
 * DOs only come into being through the worker runtime, so this is an
 * HTTP client: it POSTs real `/push` mutations to a running worker
 * (`--base`, default local `wrangler dev`). It is unauthenticated — the
 * Seed Pool is `ownerless` (editable so promote can append to it) and
 * the Blanks are `viewer` (publicly readable, not editable). Locking
 * that down is deferred (see `initList`'s deferred-auth note).
 *
 * Idempotent: every id is derived deterministically from the slug, and
 * the server primitives are INSERT-OR-IGNORE with child-ref dedupe, so
 * re-running `promote` is a no-op for already-promoted seeds.
 */

/** url-safe 64-char alphabet for deterministic id suffixes. */
const URLSAFE =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Mirrors `workers/src/id` ID_LENGTH so derived ids pass `parseKey`. */
const ID_SUFFIX_LEN = 21;
/** Mirrors `workers/src/id` IdTypes — stable wire prefixes. */
const ID_PREFIX = { group: 'g', item: 'i', list: 'l', template: 't' } as const;

/** Deterministic 21-char url-safe suffix from a seed string (sha256 → alphabet). */
function detSuffix(seed: string): string {
    const hash = createHash('sha256').update(seed).digest();
    const chars: string[] = [];
    for (let i = 0; i < ID_SUFFIX_LEN; i++) {
        chars.push(URLSAFE[hash[i]! % 64]!);
    }
    return chars.join('');
}

/** Deterministic prefixed id, e.g. `detId('template', 'wrong-window')`. */
function detId(kind: keyof typeof ID_PREFIX, seed: string): string {
    return `${ID_PREFIX[kind]}/${detSuffix(seed)}`;
}

/**
 * The one global Seed Pool List — a well-known deterministic singleton.
 * Mirrors `SEED_POOL_LIST_ID` in `workers/src/list/index.ts` (the homepage
 * reads it from there); both resolve to the same literal because the seed
 * (`'djibb:seed_pool'`) and the derivation are frozen. Kept self-derived
 * here rather than imported because Node's type-stripping can't follow the
 * worker tree's extensionless relative imports.
 */
const SEED_POOL_LIST_ID = detId('list', 'djibb:seed_pool');

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A boolean checklist quantity (unchecked): the Seed Pool item shape. */
const BOOLEAN_UNCHECKED = { value: 0, target_value: 1, unit: 'boolean' };

/**
 * Map a parsed Markdown list to `initList` content args (groups, items,
 * top-level child order) for a Blank Template `blankId`. Element ids are
 * deterministic from `slug` + position, so re-promoting the same seed
 * reuses the same ids (idempotent).
 */
function buildBlankContent(slug: string, blankId: string, model: MarkdownList) {
    const ts = nowIso();
    const groups: Record<string, unknown>[] = [];
    const items: Record<string, unknown>[] = [];
    const childElementRefs: string[] = [];

    const mkItem = (id: string, parentRef: string, name: string, description: string | undefined, value: unknown) => ({
        id,
        name,
        ...(description ? { description } : {}),
        parent_element_ref: parentRef,
        references_entity_id: null,
        value,
        type: 'item',
        version: 0,
        time_created: ts,
        time_updated: ts,
        time_deleted: null,
    });

    model.children.forEach((child, ci) => {
        if (child.kind === 'group') {
            const gid = detId('group', `${slug}#c${ci}`);
            const groupItemRefs: string[] = [];
            child.items.forEach((it, ii) => {
                const iid = detId('item', `${slug}#c${ci}.i${ii}`);
                items.push(mkItem(iid, gid, it.name, it.description, it.quantity));
                groupItemRefs.push(iid);
            });
            groups.push({
                id: gid,
                name: child.name,
                ...(child.description ? { description: child.description } : {}),
                parent_element_ref: blankId,
                child_element_refs: groupItemRefs,
                type: 'group',
                version: 0,
                time_created: ts,
                time_updated: ts,
                time_deleted: null,
            });
            childElementRefs.push(gid);
        } else {
            const iid = detId('item', `${slug}#c${ci}`);
            items.push(mkItem(iid, blankId, child.name, child.description, child.quantity));
            childElementRefs.push(iid);
        }
    });

    return { groups, items, childElementRefs };
}

/**
 * POST one mutation to a worker `/push`. A fresh `clientID` per call has
 * `lastMutationId: 0` server-side, so `id: 1` always validates; the
 * unauthed envelope (`accountId: null`) rides inside `args`.
 */
async function pushMutation(
    base: string,
    origin: string,
    kind: 'list' | 'template',
    entityId: string,
    name: string,
    args: Record<string, unknown>
): Promise<void> {
    const url = `${base.replace(/\/$/, '')}/${kind}/push?id=${encodeURIComponent(entityId)}`;
    const res = await fetch(url, {
        method: 'POST',
        // The worker's CSRF gate (index.ts) rejects non-GET requests
        // whose `Origin` isn't in AUTHORIZED_DOMAINS with an empty 403.
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({
            profileID: 'djibb-cli',
            clientGroupID: randomUUID(),
            pushVersion: 1,
            schemaVersion: '',
            mutations: [
                {
                    id: 1,
                    clientID: randomUUID(),
                    name,
                    args: { ...args, accountId: null, timestamp_client: nowIso() },
                    timestamp: Date.now(),
                },
            ],
        }),
    });
    if (!res.ok) {
        let detail = '';
        try {
            detail = JSON.stringify(await res.json());
        } catch {
            detail = await res.text().catch(() => '');
        }
        throw new Error(`HTTP ${res.status} ${detail}`);
    }
}

/**
 * Does an entity already exist? A `viewer` Blank is immutable to the
 * unauthed promoter (re-running `initList` on it is correctly rejected),
 * so re-promote idempotency comes from skipping ones that already exist
 * rather than from re-running the mutator. GET isn't CSRF-gated.
 */
async function entityExists(
    base: string,
    kind: 'list' | 'template',
    entityId: string
): Promise<boolean> {
    const url = `${base.replace(/\/$/, '')}/${kind}?id=${encodeURIComponent(entityId)}`;
    const res = await fetch(url);
    return res.ok;
}

/** Retry a push a few times — the Seed Pool's D1 row lags its init push. */
async function pushWithRetry(fn: () => Promise<void>, attempts = 5): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await sleep(400 * (i + 1));
        }
    }
    throw lastErr;
}

async function cmdPromote(args: string[]): Promise<number> {
    const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const base = flag('--base') ?? 'http://localhost:8787';
    // Must be an AUTHORIZED_DOMAINS entry (the worker's CSRF origin check).
    // Default to the local pages dev origin; pass --origin for prod.
    const origin =
        flag('--origin') ??
        (base.includes('localhost') || base.includes('127.0.0.1')
            ? 'http://localhost:5173'
            : 'https://djibb.com');
    const dryRun = args.includes('--dry-run');
    const show = args.includes('--show');

    // Positionals, skipping `--base <value>` and boolean flags.
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--base' || a === '--origin') {
            i++;
            continue;
        }
        if (a.startsWith('--')) continue;
        positional.push(a);
    }

    let targets: Array<{ path: string; label: string }>;
    try {
        targets = await resolveTargets(positional[0]);
    } catch (err) {
        console.error(c.red((err as Error).message));
        return 1;
    }
    if (targets.length === 0) {
        console.error(c.yellow('nothing to promote (no .md files found)'));
        return 1;
    }

    // Parse + plan every seed before pushing anything, so a bad seed
    // fails the whole run before it half-promotes.
    type Plan = {
        slug: string;
        blankId: string;
        model: MarkdownList;
        blankArgs: Record<string, unknown>;
        item: Record<string, unknown>;
    };
    const plans: Plan[] = [];
    for (const { path, label } of targets) {
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch (err) {
            console.error(c.red(`could not read ${path}: ${(err as Error).message}`));
            return 1;
        }
        let model: MarkdownList;
        try {
            model = parseMarkdown(raw);
        } catch (err) {
            console.error(c.red(`could not parse ${label}: ${(err as Error).message}`));
            return 1;
        }
        const slug = model.slug ?? (slugify(model.name) || label.replace(/\.md$/, ''));
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
            console.error(c.red(`${label}: slug "${slug}" is not kebab-case`));
            return 1;
        }
        const blankId = detId('template', slug);
        const { groups, items, childElementRefs } = buildBlankContent(slug, blankId, model);
        plans.push({
            slug,
            blankId,
            model,
            blankArgs: {
                listId: blankId,
                workspaceId: null,
                name: model.name,
                ...(model.description ? { description: model.description } : {}),
                childElementRefs,
                groups,
                items,
                defaultRole: 'viewer',
            },
            item: {
                id: detId('item', `seed_pool#${slug}`),
                name: model.name,
                parent_element_ref: SEED_POOL_LIST_ID,
                references_entity_id: blankId,
                value: BOOLEAN_UNCHECKED,
                type: 'item',
                version: 0,
                time_created: nowIso(),
                time_updated: nowIso(),
                time_deleted: null,
            },
        });
    }

    console.log(
        `${c.bold('promote')} ${c.dim('→')} ${c.bold(base)}  ` +
            `seed pool ${c.dim(SEED_POOL_LIST_ID)}`
    );
    for (const p of plans) {
        const g = p.model.children.filter(ch => ch.kind === 'group').length;
        const it =
            p.model.children.filter(ch => ch.kind === 'item').length +
            p.model.children.reduce((n, ch) => n + (ch.kind === 'group' ? ch.items.length : 0), 0);
        console.log(
            `  ${c.bold(p.slug)} ${c.dim('→ ' + p.blankId)} · ${g} group(s) · ${it} item(s)`
        );
        if (show) {
            console.log(c.dim('    blank args: ') + JSON.stringify(p.blankArgs));
            console.log(c.dim('    pool item:  ') + JSON.stringify(p.item));
        }
    }

    if (dryRun) {
        console.log(`\n${c.yellow('dry run')} — nothing pushed`);
        return 0;
    }

    // 1. Ensure the Seed Pool exists (ownerless so we can append to it).
    try {
        await pushMutation(base, origin, 'list', SEED_POOL_LIST_ID, 'initList', {
            listId: SEED_POOL_LIST_ID,
            workspaceId: null,
            name: 'Seed Pool',
            slot: 'seed_pool',
            defaultRole: 'ownerless',
        });
        console.log(`\n${PASS} seed pool ready`);
    } catch (err) {
        console.error(c.red(`seed pool init failed: ${(err as Error).message}`));
        console.error(c.dim(`  (is the worker running at ${base}?)`));
        return 1;
    }

    // 2. Mint each Blank Template (read-only viewer, full content inline).
    //    Skip ones that already exist — a viewer Blank can't be re-inited
    //    (that's the immutability we want); idempotency lives here.
    for (const p of plans) {
        try {
            if (await entityExists(base, 'template', p.blankId)) {
                console.log(`${PASS} blank ${c.bold(p.slug)} ${c.dim('(exists, skipped)')}`);
                continue;
            }
            await pushMutation(base, origin, 'template', p.blankId, 'initList', p.blankArgs);
            console.log(`${PASS} blank ${c.bold(p.slug)}`);
        } catch (err) {
            console.error(c.red(`✗ blank ${p.slug} failed: ${(err as Error).message}`));
            return 1;
        }
    }

    // 3. Add a referencing item to the Seed Pool (retry: D1 row lags init).
    let failed = 0;
    for (const p of plans) {
        try {
            await pushWithRetry(() =>
                pushMutation(base, origin, 'list', SEED_POOL_LIST_ID, 'createListItem', {
                    item: p.item,
                })
            );
            console.log(`${PASS} pooled ${c.bold(p.slug)}`);
        } catch (err) {
            console.error(c.red(`✗ pool item ${p.slug} failed: ${(err as Error).message}`));
            failed++;
        }
    }

    console.log(
        `\n${failed === 0 ? PASS : FAIL} ${c.bold(`${plans.length - failed}/${plans.length} promoted`)}`
    );
    return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, { run: (args: string[]) => Promise<number>; help: string }> = {
    contribute: {
        run: cmdContribute,
        help:
            'Add an example List to seed/contributed/ and round-trip it.\n' +
            '    djibb contribute --path <file.md>            contribute an existing file\n' +
            "    djibb contribute -m '# Title\\n- [ ] item'     contribute inline markdown\n" +
            '    flags: --slug <s>  --by <name>  --force  --show',
    },
    promote: {
        run: cmdPromote,
        help:
            'Promote seed(s) into the live Seed Pool via a running worker.\n' +
            '    djibb promote                    promote every seed in ./seed/contributed/\n' +
            '    djibb promote <slug>             promote one seed\n' +
            '    flags: --base <url> (default http://localhost:8787)\n' +
            '           --origin <url> (CSRF origin; default http://localhost:5173)  --dry-run  --show',
    },
    'test-parse': {
        run: cmdTestParse,
        help:
            'Round-trip a Markdown list through the ADR-0012 encoder.\n' +
            '    djibb test-parse                 every list in ./seed/contributed/ (searched up from cwd)\n' +
            '    djibb test-parse <slug>          one seed by slug (e.g. wrong-window)\n' +
            '    djibb test-parse <path/to.md>    one file by path',
    },
};

function usage(): void {
    console.log(c.bold('djibb') + c.dim(' — building beautiful, remixable checklists') + '\n');
    console.log('Usage: djibb <command> [args]\n');
    console.log('Commands:');
    for (const [name, { help }] of Object.entries(COMMANDS)) {
        console.log(`  ${c.bold(name)}\n    ${help.split('\n').join('\n    ')}\n`);
    }
}

async function main(): Promise<number> {
    const [command, ...rest] = process.argv.slice(2);
    if (!command || command === '-h' || command === '--help' || command === 'help') {
        usage();
        return command ? 0 : 1;
    }
    const entry = COMMANDS[command];
    if (!entry) {
        console.error(c.red(`unknown command: ${command}\n`));
        usage();
        return 1;
    }
    return entry.run(rest);
}

main().then(
    code => process.exit(code),
    err => {
        console.error(c.red(err?.stack ?? String(err)));
        process.exit(1);
    }
);
