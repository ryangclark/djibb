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

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';

import { parseMarkdown, encodeMarkdown } from '../src/list/markdown.ts';

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
        const head = result.ok ? PASS : FAIL;
        console.log(`\n${head} ${c.bold(result.label)}`);
        for (const note of result.notes) console.log(`  ${note}`);
        if (show && result.canonical) {
            console.log(c.dim('  ── canonical ──'));
            console.log(result.canonical.replace(/^/gm, '  '));
        }
        if (!result.ok) failed++;
    }

    const total = targets.length;
    console.log(`\n${failed === 0 ? PASS : FAIL} ${c.bold(`${total - failed}/${total} passed`)}`);
    return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, { run: (args: string[]) => Promise<number>; help: string }> = {
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
