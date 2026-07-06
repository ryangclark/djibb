import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0025: all D1 SQL lives in exactly three owner modules; every other
 * file calls named operations on them.
 *
 * This guard enforces the discipline with a shrink-only ratchet:
 *  - a file outside the owner modules may not issue `.prepare(`/`.batch(`
 *    unless it appears in ALLOWLIST (the pre-ADR offenders),
 *  - an allowlisted file may never *gain* call sites,
 *  - when an allowlisted file loses call sites, its entry must be lowered
 *    (or removed at zero) so the count can only fall.
 *
 * If this test just failed on a file you're editing: don't add inline D1
 * SQL. Add a named operation to the owning d1 module instead —
 * `derived-index/d1.ts` for the Derived Index projection tables,
 * `auth/d1.ts` for the auth substrate, `account/d1.ts` for usernames —
 * and call that. See docs/adr/0025-d1-storage-discipline.md.
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src');

/** The only files allowed to issue D1 SQL (repo-relative to src/). */
const OWNER_MODULES = new Set([
    'auth/d1.ts',
    'account/d1.ts',
    'derived-index/d1.ts',
]);

/**
 * Pre-ADR-0025 offenders and their call-site counts at ratchet start.
 * Shrink-only: lower (or delete at zero) as files migrate; never raise.
 */
const ALLOWLIST = new Map<string, number>([
    ['account/service.ts', 5],
    ['account/username.ts', 2],
    ['auth/connected.ts', 4],
    ['auth/credential.ts', 4],
    ['auth/magic.ts', 4],
    ['auth/session.ts', 8],
    ['catalog/service.ts', 4],
    ['list/durable_object.ts', 6],
    ['list/invitations.ts', 11],
    ['list/slug.ts', 2],
    ['workspace/service.ts', 3],
]);

const D1_CALL = /\.(?:prepare|batch)\(/g;

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });
}

function countCallSites(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const path of walk(SRC_ROOT)) {
        const rel = relative(SRC_ROOT, path).split(sep).join('/');
        const matches = readFileSync(path, 'utf8').match(D1_CALL);
        if (matches) counts.set(rel, matches.length);
    }
    return counts;
}

describe('D1 storage discipline (ADR 0025)', () => {
    const counts = countCallSites();

    it('no D1 SQL outside the owner modules and the shrinking allowlist', () => {
        const violations: string[] = [];
        for (const [file, count] of counts) {
            if (OWNER_MODULES.has(file)) continue;
            const allowed = ALLOWLIST.get(file);
            if (allowed === undefined) {
                violations.push(
                    `${file}: ${count} D1 call site(s). New D1 SQL belongs in the ` +
                        `owning d1 module (ADR 0025) — add a named operation there and call it.`
                );
            } else if (count > allowed) {
                violations.push(
                    `${file}: grew from ${allowed} to ${count} D1 call site(s). ` +
                        `The allowlist only shrinks — move the new query into the owning d1 module.`
                );
            }
        }
        expect(violations, violations.join('\n')).toEqual([]);
    });

    it('ratchet: allowlist entries that came clean are lowered or removed', () => {
        const stale: string[] = [];
        for (const [file, allowed] of ALLOWLIST) {
            const count = counts.get(file) ?? 0;
            if (count === 0) {
                stale.push(
                    `${file} no longer issues D1 SQL — remove it from ALLOWLIST to lock that in.`
                );
            } else if (count < allowed) {
                stale.push(
                    `${file} is down to ${count} call site(s) (allowlist says ${allowed}) — ` +
                        `lower its ALLOWLIST entry to ${count}.`
                );
            }
        }
        expect(stale, stale.join('\n')).toEqual([]);
    });

    it('owner d1 modules do not import route or service files', () => {
        const violations: string[] = [];
        for (const owner of OWNER_MODULES) {
            const path = join(SRC_ROOT, ...owner.split('/'));
            let source: string;
            try {
                source = readFileSync(path, 'utf8');
            } catch {
                continue; // module not carved out yet
            }
            const badImports = [
                ...source.matchAll(/from\s+['"]([^'"]*(?:fetch|service|durable_object)[^'"]*)['"]/g),
            ].map((m) => m[1]);
            for (const imp of badImports) {
                violations.push(
                    `${owner} imports "${imp}" — d1 modules sit below routes/services; ` +
                        `the dependency direction only points down.`
                );
            }
        }
        expect(violations, violations.join('\n')).toEqual([]);
    });
});
