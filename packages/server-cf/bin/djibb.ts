#!/usr/bin/env node
/**
 * `djibb` — the project CLI. v0.1.
 *
 * Three subcommands:
 *
 *   - `test-parse` runs a Markdown file through the ADR-0012 content
 *     encoder (`parseMarkdown` <-> `encodeMarkdown`) and checks the two
 *     round-trip invariants the module guarantees. The pure, offline
 *     dogfooding surface — a contributed List *is* a test of the system.
 *   - `contribute` pushes a List as a fresh Blank Template + a referencing
 *     item on the live **Contributed** List (issue #9). Anonymous: it only
 *     *appends* to the already-existing operator-owned Contributed List
 *     (`default_role: 'submitter'`, ADR 0021), so it needs no token.
 *   - `promote` (operator) bootstraps both platform Lists, reads the
 *     Contributed List, and references chosen Blanks from the Seed Pool.
 *
 * Pure and dependency-free, like the module it exercises: it runs under plain
 * `node` via TypeScript type-stripping (Node >= 23.6), no build step.
 *
 *   ./djibb test-parse path/to/list.md # round-trip one file by path
 *   ./djibb test-parse -m '# T\n- [ ] x'   # round-trip inline markdown
 *   ./djibb contribute --path list.md --base <url>   # append to Contributed List
 *   ./djibb promote --base <url>       # bootstrap + source the Seed Pool
 */

import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

import { parseMarkdown, encodeMarkdown } from '@djibb/protocol/list/markdown';
import type { MarkdownGroup, MarkdownList } from '@djibb/protocol/list/markdown';

/** Total items in a group, recursing through nested subgroups. */
function groupItemCount(g: MarkdownGroup): number {
    return g.children.reduce(
        (n, ch) => n + (ch.kind === 'item' ? 1 : groupItemCount(ch)),
        0
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
    return testParseRaw(raw, label);
}

/**
 * The pure round-trip on raw Markdown (no filesystem). Shared by
 * `test-parse` (file or `-m`) and `contribute`'s dogfood feedback.
 */
function testParseRaw(raw: string, label: string): FileResult {
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
    const grouped = groups.reduce((n, g) => n + (g.kind === 'group' ? groupItemCount(g) : 0), 0);
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

/**
 * Reject unrecognized `--flags`. Each command's positional/flag parsing
 * silently ignores any `--token` it doesn't look for, so a typo like
 * `--dryrun` (vs `--dry-run`) would no-op instead of erroring. Returns a
 * message naming the offenders, or `null` if every `--flag` is known.
 * Only double-dash tokens are checked; flag *values* (e.g. the URL after
 * `--base`) don't start with `--`, and `-m` is handled explicitly.
 */
function unknownFlags(args: string[], known: readonly string[]): string | null {
    const offenders = args.filter(a => a.startsWith('--') && !known.includes(a));
    return offenders.length ? `unknown flag(s): ${offenders.join(', ')}` : null;
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
    const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const badFlag = unknownFlags(args, ['--show', '--message']);
    if (badFlag) {
        console.error(c.red(`test-parse: ${badFlag}`));
        return 1;
    }
    const show = args.includes('--show');
    const message = flag('-m') ?? flag('--message');
    // Positionals, skipping the `-m`/`--message` value.
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '-m' || a === '--message') {
            i++;
            continue;
        }
        if (a.startsWith('--')) continue;
        positional.push(a);
    }
    const path = positional[0];

    if (!path && !message) {
        console.error(
            c.red('test-parse needs a source: a file path or -m "<list markdown>"')
        );
        return 1;
    }
    if (path && message) {
        console.error(c.red('pass only one of <path> or -m, not both'));
        return 1;
    }

    const result = message
        ? testParseRaw(message, '(inline)')
        : await testParseFile(resolve(process.cwd(), path!), path!);
    printFileResult(result, show);
    console.log(`\n${result.ok ? PASS : FAIL} ${c.bold(`${result.ok ? 1 : 0}/1 passed`)}`);
    return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// shared HTTP / id infra (contribute + promote)
// ---------------------------------------------------------------------------

/**
 * `contribute` and `promote` both speak to a running worker over HTTP —
 * DOs only come into being through the worker runtime. The id helpers,
 * the well-known singletons, the push/pull/exists primitives, and the
 * Blank-content builder below are shared by both commands.
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
 * Random (non-deterministic) prefixed id — the CLI mirror of
 * `newId('template')` (`packages/protocol/src/id`). Used by `contribute`
 * to mint a Blank with an *unguessable* id: a contributed Blank's id
 * mustn't be derivable from its slug (a slug-derived id would let anyone
 * pre-compute and squat the entity). `& 63` over crypto-random bytes is
 * uniform across the 64-char alphabet, matching `randomString`.
 */
function randomId(kind: keyof typeof ID_PREFIX): string {
    const bytes = randomBytes(ID_SUFFIX_LEN);
    let s = '';
    for (const b of bytes) s += URLSAFE[b & 63]!;
    return `${ID_PREFIX[kind]}/${s}`;
}

/**
 * The one global Seed Pool List — a well-known deterministic singleton.
 * Mirrors `SEED_POOL_LIST_ID` in `packages/protocol/src/list/index.ts`
 * (the homepage reads it from there); both resolve to the same literal
 * because the seed (`'djibb:seed_pool'`) and the derivation are frozen.
 * Kept self-derived here rather than imported because Node's
 * type-stripping can't follow the worker tree's extensionless relative
 * imports.
 */
const SEED_POOL_LIST_ID = detId('list', 'djibb:seed_pool');

/**
 * The one global Contributed List — the append-only holding pen
 * `contribute` writes into (issue #9, ADR 0021). Mirrors
 * `CONTRIBUTED_LIST_ID` in `packages/protocol/src/list/index.ts`,
 * re-derived here for the same reason as `SEED_POOL_LIST_ID`. The
 * assertion below fails the CLI loudly if the two ever drift.
 */
const CONTRIBUTED_LIST_ID = detId('list', 'djibb:contributed');

// Drift guard: these literals are the single source of truth in
// `packages/protocol/src/list/index.ts`. Re-deriving them here and
// asserting the values match means a change to the derivation or seed in
// either place fails the CLI loudly instead of silently bootstrapping a
// different List than the site reads.
if (SEED_POOL_LIST_ID !== 'l/LWmRT14-cOUtJ9-nsSwQe') {
    throw new Error(`SEED_POOL_LIST_ID drift: ${SEED_POOL_LIST_ID}`);
}
if (CONTRIBUTED_LIST_ID !== 'l/RG5n-jjnV9BmqO4WSr4Eu') {
    throw new Error(`CONTRIBUTED_LIST_ID drift: ${CONTRIBUTED_LIST_ID}`);
}

/**
 * The platform operator account. Mirrors `OPERATOR_ACCOUNT_ID` in
 * `packages/protocol/src/list/index.ts` (re-declared, not imported, for
 * the same reason `SEED_POOL_LIST_ID` is re-derived here). `promote`
 * stamps this as the mutation `accountId` and sends the operator's
 * session cookie, so the DO resolves it to `owner` and the `initList`
 * guard admits the privileged `slot`/`defaultRole` fields. `contribute`
 * never sends it — it pushes anonymously.
 */
const OPERATOR_ACCOUNT_ID = 'a/djibb';

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

    // Mint a group and its whole subtree (ADR 0012 §G, option B): nested
    // subgroups become real group rows parented to their enclosing group, in
    // document order. `initList` writes whatever rows it's handed and imposes
    // no group-parents-list rule, so nesting needs nothing more here. Ids stay
    // deterministic from the position path, so re-promoting is idempotent.
    const mintGroup = (g: MarkdownGroup, parentRef: string, path: string): string => {
        const gid = detId('group', path);
        const refs: string[] = [];
        g.children.forEach((ch, i) => {
            if (ch.kind === 'item') {
                const iid = detId('item', `${path}.i${i}`);
                items.push(mkItem(iid, gid, ch.name, ch.description, ch.quantity));
                refs.push(iid);
            } else {
                refs.push(mintGroup(ch, gid, `${path}.s${i}`));
            }
        });
        groups.push({
            id: gid,
            name: g.name,
            ...(g.description ? { description: g.description } : {}),
            parent_element_ref: parentRef,
            child_element_refs: refs,
            type: 'group',
            version: 0,
            time_created: ts,
            time_updated: ts,
            time_deleted: null,
        });
        return gid;
    };

    model.children.forEach((child, ci) => {
        if (child.kind === 'group') {
            childElementRefs.push(mintGroup(child, blankId, `${slug}#c${ci}`));
        } else {
            const iid = detId('item', `${slug}#c${ci}`);
            items.push(mkItem(iid, blankId, child.name, child.description, child.quantity));
            childElementRefs.push(iid);
        }
    });

    return { groups, items, childElementRefs };
}

/** An HTTP failure that carries the status code, so callers can branch on it. */
class HttpError extends Error {
    status: number;
    constructor(status: number, detail: string) {
        super(`HTTP ${status} ${detail}`.trim());
        this.name = 'HttpError';
        this.status = status;
    }
}

async function httpDetail(res: Response): Promise<string> {
    // Read the body exactly once (a Response body is a single-use stream —
    // a `res.json()`-then-`res.text()` fallback would throw on the consumed
    // stream and lose the detail). Take it as text, then re-stringify if it
    // happens to be JSON so the message is normalized.
    const text = await res.text().catch(() => '');
    try {
        return JSON.stringify(JSON.parse(text));
    } catch {
        return text;
    }
}

/**
 * Build the headers every `djibb` worker request shares. `Origin` clears
 * the worker's CSRF gate (index.ts rejects non-GET requests whose `Origin`
 * isn't in AUTHORIZED_DOMAINS). A `bearerToken` is the caller's
 * *credential* — an `issued_credentials` API key (ADR 0022), sent as
 * `Authorization: Bearer`. It says who the caller is; the server's auth
 * layer (the bearer seam in `auth/middleware.ts` → `auth/resolver.ts` +
 * the DO) decides what that identity may do. Omit it to call anonymously.
 * This is the one place a request attaches the operator credential, so new
 * `djibb <verb>` commands authenticate consistently.
 */
function djibbRequestHeaders(
    origin: string,
    bearerToken?: string
): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Origin: origin,
    };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    return headers;
}

/**
 * POST one mutation to a worker `/push`. A fresh `clientID` per call has
 * `lastMutationId: 0` server-side, so `id: 1` always validates.
 *
 * Two actors:
 *   - **operator** (`promote`): pass `bearerToken`. The token authenticates
 *     as the operator Account via `Authorization: Bearer` and
 *     `OPERATOR_ACCOUNT_ID` is stamped into the envelope — the DO's
 *     cross-account check verifies the two agree, then resolves the
 *     operator to `owner` (admitting privileged `initList` fields).
 *   - **anonymous** (`contribute`): omit `bearerToken`. No credential, a
 *     `null` envelope `accountId` — the DO resolves the caller to the
 *     list's `default_role` (`submitter` on the Contributed List, so
 *     `createListItem` is admitted while every other mutator 403s).
 */
async function pushMutation(
    base: string,
    origin: string,
    kind: 'list' | 'template',
    entityId: string,
    name: string,
    args: Record<string, unknown>,
    opts: { accountId: string | null; bearerToken?: string }
): Promise<void> {
    const url = `${base.replace(/\/$/, '')}/${kind}/push?id=${encodeURIComponent(entityId)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: djibbRequestHeaders(origin, opts.bearerToken),
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
                    args: {
                        ...args,
                        accountId: opts.accountId,
                        timestamp_client: nowIso(),
                    },
                    timestamp: Date.now(),
                },
            ],
        }),
    });
    if (!res.ok) throw new HttpError(res.status, await httpDetail(res));
}

/** One element op from a `/pull` response patch. */
type PullPut = { op: 'put'; key: string; value: Record<string, unknown> };

/**
 * POST a fresh (`cookie: null`) `/pull` for `listId` and return its
 * `put` ops. Pass `bearerToken` to read as the operator: since the
 * view-floor landed (#13), below-floor roles (the Contributed List is
 * `default_role: 'submitter'`) get an empty patch, so an anonymous pull
 * sees nothing. The operator owns the platform Lists, so its credential
 * resolves above the floor and reads the full tree. The Replicache
 * `cookie: null` in the body is the pull baseline (unrelated to auth).
 */
async function pullList(
    base: string,
    origin: string,
    listId: string,
    bearerToken?: string
): Promise<PullPut[]> {
    const url = `${base.replace(/\/$/, '')}/list/pull?id=${encodeURIComponent(listId)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: djibbRequestHeaders(origin, bearerToken),
        body: JSON.stringify({
            pullVersion: 1,
            profileID: 'djibb-cli',
            clientGroupID: randomUUID(),
            cookie: null,
            schemaVersion: '',
        }),
    });
    if (!res.ok) throw new HttpError(res.status, await httpDetail(res));
    const body = (await res.json()) as { patch?: Array<Record<string, unknown>> };
    return (body.patch ?? []).filter(
        (p): p is PullPut => p.op === 'put' && typeof p.value === 'object'
    );
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

/** Production worker URL — the API, not the Pages frontend (see docs/DEPLOY.md). */
const PROD_BASE = 'https://api.djibb.com';

/**
 * Resolve `--base` (worker URL) and `--origin` (CSRF Origin header).
 * Both commands default to the live site when `--base` is absent — a
 * contributor shouldn't need to know a URL to add to it, and the operator
 * normally promotes against prod too. Pass `--base http://localhost:8787`
 * to target a local `wrangler dev`. The origin must be an
 * `AUTHORIZED_DOMAINS` entry; it tracks the base — local pages dev origin
 * for a local base, else prod.
 */
function resolveBaseOrigin(
    flag: (n: string) => string | undefined,
    defaultBase: string = PROD_BASE
): {
    base: string;
    origin: string;
} {
    const base = flag('--base') ?? defaultBase;
    const origin =
        flag('--origin') ??
        (base.includes('localhost') || base.includes('127.0.0.1')
            ? 'http://localhost:5173'
            : 'https://djibb.com');
    return { base, origin };
}

// ---------------------------------------------------------------------------
// contribute
// ---------------------------------------------------------------------------

/**
 * Contribute an example List to the live **Contributed** List (issue #9,
 * ADR 0021). The List is "lists all the way down": a contribution is a
 * fresh **Blank Template** Durable Object (ownerless, anonymously
 * created) plus a referencing item appended to the operator-owned
 * Contributed List.
 *
 * **No operator token.** The Contributed List is `default_role:
 * 'submitter'` (append-only): an anonymous caller resolves to `submitter`
 * and so may `createListItem` (the one mutator widened to `APPEND_ROLES`)
 * but nothing else. So `contribute` only ever *appends* to an
 * already-bootstrapped List — the operator runs `djibb promote` once to
 * create it.
 *
 * Source is an existing file (`--path`) or inline Markdown (`-m`). The
 * Blank gets a *random* (unguessable) id so it can't be slug-squatted;
 * its element ids stay slug-derived. Same round-trip dogfood feedback as
 * `test-parse` runs first, so a bad list fails before anything is pushed.
 */
async function cmdContribute(args: string[]): Promise<number> {
    const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const badFlag = unknownFlags(args, [
        '--show', '--dry-run', '--path', '--message', '--slug', '--base', '--origin',
    ]);
    if (badFlag) {
        console.error(c.red(`contribute: ${badFlag}`));
        return 1;
    }
    const show = args.includes('--show');
    const dryRun = args.includes('--dry-run');
    const path = flag('--path');
    const message = flag('-m') ?? flag('--message');
    const slugFlag = flag('--slug');
    // Contribute targets the live site by default — no URL to memorize.
    const { base, origin } = resolveBaseOrigin(flag, PROD_BASE);

    if (!path && !message) {
        console.error(
            c.red('contribute needs a source: --path <file.md> or -m "<list markdown>"')
        );
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
    let model: MarkdownList;
    try {
        model = parseMarkdown(raw);
    } catch (err) {
        console.error(c.red(`could not parse the list: ${(err as Error).message}`));
        return 1;
    }

    // 3. Resolve the slug (drives deterministic *element* ids, not the
    //    Blank id): flag wins, then frontmatter, then the title.
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

    // 4. Dogfood it first: the same round-trip `test-parse` runs, so a
    //    malformed list fails locally before anything reaches the server.
    const result = testParseRaw(raw, slug);
    printFileResult(result, show);
    if (!result.ok) {
        console.error(c.red('\nround-trip failed — not contributing'));
        return 1;
    }

    // 5. Plan: a random-id Blank + a referencing item on the Contributed List.
    const blankId = randomId('template');
    const { groups, items, childElementRefs } = buildBlankContent(slug, blankId, model);
    const blankArgs: Record<string, unknown> = {
        listId: blankId,
        workspaceId: null,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        childElementRefs,
        groups,
        items,
        // Anonymous ⇒ ownerless Blank. No `slot`/`defaultRole`: those are
        // operator-only, and an anon caller sending them would 403.
    };
    const item: Record<string, unknown> = {
        id: randomId('item'),
        name: model.name,
        parent_element_ref: CONTRIBUTED_LIST_ID,
        references_entity_id: blankId,
        value: BOOLEAN_UNCHECKED,
        type: 'item',
        version: 0,
        time_created: nowIso(),
        time_updated: nowIso(),
        time_deleted: null,
    };

    console.log(
        `\n${c.bold('contribute')} ${c.dim('→')} ${c.bold(base)}  ` +
            `contributed list ${c.dim(CONTRIBUTED_LIST_ID)}`
    );
    const g = model.children.filter(ch => ch.kind === 'group').length;
    const it =
        model.children.filter(ch => ch.kind === 'item').length +
        model.children.reduce((n, ch) => n + (ch.kind === 'group' ? groupItemCount(ch) : 0), 0);
    console.log(`  ${c.bold(slug)} ${c.dim('→ ' + blankId)} · ${g} group(s) · ${it} item(s)`);
    if (show) {
        console.log(c.dim('    blank args: ') + JSON.stringify(blankArgs));
        console.log(c.dim('    pool item:  ') + JSON.stringify(item));
    }

    if (dryRun) {
        console.log(`\n${c.yellow('dry run')} — nothing pushed`);
        return 0;
    }

    // 6. Push the Blank (anon ⇒ ownerless), then append a reference to the
    //    Contributed List (anon ⇒ submitter ⇒ createListItem allowed).
    try {
        await pushMutation(base, origin, 'template', blankId, 'initList', blankArgs, {
            accountId: null,
        });
        console.log(`${PASS} blank ${c.bold(slug)} ${c.dim(blankId)}`);
    } catch (err) {
        console.error(c.red(`✗ blank init failed: ${(err as Error).message}`));
        console.error(c.dim(`  (is the worker running at ${base}?)`));
        return 1;
    }

    try {
        await pushWithRetry(() =>
            pushMutation(base, origin, 'list', CONTRIBUTED_LIST_ID, 'createListItem', {
                item,
            }, { accountId: null })
        );
        console.log(`${PASS} contributed ${c.bold(slug)}`);
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
            console.error(
                c.red('✗ the Contributed List does not exist yet.') +
                    ' Ask the operator to bootstrap it with `djibb promote`.'
            );
            return 1;
        }
        console.error(c.red(`✗ contribute failed: ${(err as Error).message}`));
        return 1;
    }

    console.log(`\n${PASS} ${c.bold('contributed — browse it on the Contributed List')}`);
    return 0;
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

/**
 * The macOS login-keychain coordinates the operator CLI token lives under
 * when it isn't in the environment. Seed it once with:
 *
 *   security add-generic-password -U -a djibb-operator -s DJIBB_CLI_TOKEN -w
 *
 * (`-w` prompts for the secret; `-U` updates in place if it already exists).
 * The macOS **Passwords** app can't be read from the CLI — its entries live
 * in the iCloud Keychain, which the legacy `security` tool can't reach — so
 * the operator secret rides in the file-based login keychain instead.
 */
const KEYCHAIN_ACCOUNT = 'djibb-operator';
const KEYCHAIN_SERVICE = 'DJIBB_CLI_TOKEN';

/**
 * Resolve the operator's issued-credential bearer token (ADR 0022).
 * `DJIBB_CLI_TOKEN` in the environment wins (CI, a one-off override);
 * failing that, on macOS, fall back to the login keychain via
 * `security find-generic-password`. Returns `undefined` if neither yields
 * a value (the caller reports the miss). The keychain read is best-effort:
 * a missing item, a denied prompt, or a non-macOS host all degrade quietly
 * to `undefined`. Mint/rotate the token with `bin/seed-operator.ts`.
 */
function operatorToken(): string | undefined {
    const fromEnv = process.env.DJIBB_CLI_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    if (process.platform !== 'darwin') return undefined;
    try {
        const out = execFileSync(
            'security',
            ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return out.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Promote contributed Blanks into the live homepage **Seed Pool**
 * (CONTEXT.md §Seed Pool). Bootstraps both platform Lists (idempotent),
 * reads the **Contributed** List over `/pull`, and for each chosen
 * contribution adds a referencing item to the global Seed Pool **List**
 * so the homepage can rotate through them. Each contribution is already a
 * Blank Template, so promoting = pointing the Seed Pool at that same
 * Blank.
 *
 * DOs only come into being through the worker runtime, so this is an HTTP
 * client. It authenticates as the platform **operator**
 * (`OPERATOR_ACCOUNT_ID`) via an issued-credential bearer token (ADR
 * 0022) — the only principal allowed to set the privileged
 * `slot`/`defaultRole` fields on the platform Lists. The token comes from
 * `DJIBB_CLI_TOKEN` or, failing that, the macOS login keychain (see
 * `operatorToken`). A `--dry-run` plans without the token.
 *
 * Idempotent: the Seed Pool item id is derived deterministically from the
 * Blank id and the server primitives are INSERT-OR-IGNORE with child-ref
 * dedupe, so re-running is a no-op for already-pooled contributions.
 */
async function cmdPromote(args: string[]): Promise<number> {
    const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const badFlag = unknownFlags(args, [
        '--dry-run', '--show', '--all', '--base', '--origin',
    ]);
    if (badFlag) {
        console.error(c.red(`promote: ${badFlag}`));
        return 1;
    }
    const { base, origin } = resolveBaseOrigin(flag);
    const dryRun = args.includes('--dry-run');
    const show = args.includes('--show');
    const promoteAll = args.includes('--all');

    // Operator credentials: the bearer token is the only secret. Always
    // required — a real push needs it for the privileged `slot`/`defaultRole`
    // fields (operator-only server-side), and even `--dry-run` needs it to
    // read the Contributed List, which sits below the view-floor (#13) and
    // returns an empty patch to anonymous pulls. Resolved from
    // `DJIBB_CLI_TOKEN` or, failing that, the macOS login keychain
    // (`security find-generic-password -a djibb-operator -s
    // DJIBB_CLI_TOKEN`). Mint the token with
    // `node bin/seed-operator.ts --execute --remote`.
    const operatorBearer = operatorToken();
    if (!operatorBearer) {
        console.error(
            c.red('promote needs an operator token: ') +
                'set DJIBB_CLI_TOKEN, or store it in the login keychain with\n' +
                c.dim(`  security add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w`) +
                '\n  (mint the token with `bin/seed-operator.ts`).'
        );
        return 1;
    }

    // Positionals (slug / blank-id selectors), skipping `--flag <value>`.
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
    const selectors = new Set(positional);

    console.log(
        `${c.bold('promote')} ${c.dim('→')} ${c.bold(base)}  ` +
            `seed pool ${c.dim(SEED_POOL_LIST_ID)}  contributed ${c.dim(CONTRIBUTED_LIST_ID)}`
    );

    // 1. Bootstrap home: ensure BOTH platform Lists exist (idempotent).
    //    No separate command — `promote` is the operator's one entry point.
    //      · Seed Pool   — operator-owned, default_role 'viewer' (publicly
    //        readable for the homepage, only the operator can append).
    //      · Contributed — operator-owned, default_role 'submitter' (ADR
    //        0021): anyone may append (anon `djibb contribute`), nobody but
    //        the operator may mutate existing entries (append-only).
    if (!dryRun) {
        const token = operatorBearer;
        try {
            await pushMutation(base, origin, 'list', SEED_POOL_LIST_ID, 'initList', {
                listId: SEED_POOL_LIST_ID,
                workspaceId: null,
                name: 'Seed Pool',
                slot: 'seed_pool',
                defaultRole: 'viewer',
            }, { accountId: OPERATOR_ACCOUNT_ID, bearerToken: token });
            console.log(`\n${PASS} seed pool ready`);
        } catch (err) {
            console.error(c.red(`seed pool init failed: ${(err as Error).message}`));
            console.error(c.dim(`  (is the worker running at ${base}?)`));
            return 1;
        }
        try {
            await pushMutation(base, origin, 'list', CONTRIBUTED_LIST_ID, 'initList', {
                listId: CONTRIBUTED_LIST_ID,
                workspaceId: null,
                name: 'Contributed',
                slot: 'contributed',
                defaultRole: 'submitter',
            }, { accountId: OPERATOR_ACCOUNT_ID, bearerToken: token });
            console.log(`${PASS} contributed list ready`);
        } catch (err) {
            console.error(c.red(`contributed list init failed: ${(err as Error).message}`));
            return 1;
        }
    } else {
        console.log(c.dim('\n(dry run: would bootstrap seed pool + contributed list)'));
    }

    // 2. Read the Contributed List and enumerate its referenced Blanks.
    let contributed: PullPut[];
    try {
        contributed = await pullList(base, origin, CONTRIBUTED_LIST_ID, operatorBearer);
    } catch (err) {
        console.error(c.red(`could not read the Contributed List: ${(err as Error).message}`));
        return 1;
    }

    type Candidate = { blankId: string; name: string; slug: string };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const op of contributed) {
        const v = op.value;
        if (v.type !== 'item') continue;
        const blankId = v.references_entity_id;
        if (typeof blankId !== 'string' || !blankId.startsWith(`${ID_PREFIX.template}/`)) {
            continue;
        }
        if (seen.has(blankId)) continue;
        seen.add(blankId);
        const name = typeof v.name === 'string' ? v.name : blankId;
        candidates.push({ blankId, name, slug: slugify(name) });
    }

    if (candidates.length === 0) {
        console.log(c.yellow('\nthe Contributed List has no entries to promote yet'));
        return 0;
    }

    // 3. Select: positional args match a candidate's slug or blank id
    //    (with or without the `t/` prefix); no args + `--all` ⇒ everything.
    let chosen: Candidate[];
    if (selectors.size > 0) {
        chosen = candidates.filter(
            cnd =>
                selectors.has(cnd.slug) ||
                selectors.has(cnd.blankId) ||
                selectors.has(cnd.blankId.slice(ID_PREFIX.template.length + 1))
        );
        const unmatched = [...selectors].filter(
            s =>
                !candidates.some(
                    cnd =>
                        cnd.slug === s ||
                        cnd.blankId === s ||
                        cnd.blankId.slice(ID_PREFIX.template.length + 1) === s
                )
        );
        for (const u of unmatched) {
            console.error(c.yellow(`⚠ no contributed entry matches "${u}"`));
        }
        // A slug isn't unique — two contributions with the same title slug
        // to the same value (only the Blank id is unique). Surface the
        // ambiguity so promoting "both" is a choice, not a surprise; the
        // operator can re-run with the specific blank-id(s) to narrow.
        for (const s of selectors) {
            const bySlug = candidates.filter(cnd => cnd.slug === s);
            if (bySlug.length > 1) {
                console.error(
                    c.yellow(
                        `⚠ slug "${s}" matches ${bySlug.length} entries — promoting all; ` +
                            `pass a blank-id to pick one: ${bySlug.map(cnd => cnd.blankId).join(', ')}`
                    )
                );
            }
        }
        if (chosen.length === 0) {
            console.error(c.red('nothing selected — pass a slug/blank-id that exists, or --all'));
            return 1;
        }
    } else if (promoteAll) {
        chosen = candidates;
    } else {
        console.log(`\n${c.bold('contributed entries')} (${candidates.length}):`);
        for (const cnd of candidates) {
            console.log(`  ${c.bold(cnd.slug)} ${c.dim('→ ' + cnd.blankId)} · ${cnd.name}`);
        }
        console.error(
            c.yellow('\nselect one or more by slug/blank-id, or pass --all to promote every entry')
        );
        return 1;
    }

    // Plan a Seed Pool item per chosen Blank. The item id is derived
    // deterministically from the Blank id, so re-promoting is idempotent.
    const plans = chosen.map(cnd => ({
        ...cnd,
        item: {
            id: detId('item', `seed_pool#${cnd.blankId}`),
            name: cnd.name,
            parent_element_ref: SEED_POOL_LIST_ID,
            references_entity_id: cnd.blankId,
            value: BOOLEAN_UNCHECKED,
            type: 'item',
            version: 0,
            time_created: nowIso(),
            time_updated: nowIso(),
            time_deleted: null,
        } as Record<string, unknown>,
    }));

    for (const p of plans) {
        console.log(`  ${c.bold(p.slug)} ${c.dim('→ ' + p.blankId)}`);
        if (show) console.log(c.dim('    pool item:  ') + JSON.stringify(p.item));
    }

    if (dryRun) {
        console.log(`\n${c.yellow('dry run')} — nothing pushed`);
        return 0;
    }

    // NOTE: a contributed Blank is anonymous ⇒ ownerless, so it stays
    // world-editable until the claim flow lands. Re-homing pooled Blanks
    // to operator-owned `viewer` (immutability) is the optional sub-step
    // deferred with the read view-floor work (issue #13); for now promote
    // just adds the Seed Pool reference.
    const token = operatorBearer;

    // 4. Add a referencing item to the Seed Pool (retry: D1 row lags init).
    let failed = 0;
    for (const p of plans) {
        try {
            await pushWithRetry(() =>
                pushMutation(base, origin, 'list', SEED_POOL_LIST_ID, 'createListItem', {
                    item: p.item,
                }, { accountId: OPERATOR_ACCOUNT_ID, bearerToken: token })
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
            'Push a List to the live Contributed List (no operator token).\n' +
            '    djibb contribute --path <file.md>            contribute a file (best for multi-line)\n' +
            "    djibb contribute -m $'# Title\\n- [ ] item'    contribute inline markdown\n" +
            "      tip: use $'…' so \\n is a real newline; plain '…' keeps it literal and collapses the list\n" +
            '    flags: --slug <s>  --dry-run  --show\n' +
            '           --base <url> (default https://api.djibb.com; use http://localhost:8787 for local dev)\n' +
            '           --origin <url> (CSRF origin; tracks --base)',
    },
    promote: {
        run: cmdPromote,
        help:
            'Bootstrap the platform Lists + reference Blanks from the Seed Pool.\n' +
            '    djibb promote                    bootstrap + list contributed entries\n' +
            '    djibb promote <slug|blank-id>    promote one contributed entry\n' +
            '    djibb promote --all              promote every contributed entry\n' +
            '    flags: --dry-run  --show\n' +
            '           --base <url> (default https://api.djibb.com; use http://localhost:8787 for local dev)\n' +
            '           --origin <url> (CSRF origin; tracks --base)',
    },
    'test-parse': {
        run: cmdTestParse,
        help:
            'Round-trip a Markdown list through the ADR-0012 encoder.\n' +
            '    djibb test-parse <path/to.md>    one file by path\n' +
            "    djibb test-parse -m $'# T\\n- [ ] x'   inline markdown ($'…' so \\n is a real newline)\n" +
            '    flags: --show (also print the canonical form)',
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
