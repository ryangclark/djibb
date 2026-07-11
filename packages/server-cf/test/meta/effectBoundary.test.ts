import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0015 Decision A: Effect is a backend-only spine. It lives in
 * `@djibb/server-cloudflare` (and any future backend package) and is
 * NEVER a dependency of `@djibb/protocol` or `@djibb/client` — above
 * the port is pure, Effect-free contract code shared with every
 * frontend.
 *
 * This guard makes the boundary mechanical instead of disciplinary:
 *  - no source file in protocol/ or client/ may import `effect` or any
 *    `@effect/*` package,
 *  - neither package.json may declare them as dependencies.
 *
 * If this test just failed: whatever needed Effect belongs below the
 * port, in server-cf. See docs/adr/0015-effect-as-backend-spine.md and
 * docs/plans/effect-adoption.md.
 */

const PACKAGES_ROOT = join(__dirname, '..', '..', '..');
const GUARDED_PACKAGES = ['protocol', 'client'];

// `from 'effect'`, `from 'effect/Effect'`, `from '@effect/sql-d1'`,
// plus require()/dynamic-import forms.
const EFFECT_IMPORT =
    /(?:from\s+|require\(\s*|import\(\s*)['"](?:effect(?:\/[^'"]*)?|@effect\/[^'"]*)['"]/g;

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });
}

describe('Effect stays behind the port (ADR 0015 Decision A)', () => {
    it('no effect/@effect imports in protocol or client source', () => {
        const violations: string[] = [];
        for (const pkg of GUARDED_PACKAGES) {
            const srcRoot = join(PACKAGES_ROOT, pkg, 'src');
            for (const path of walk(srcRoot)) {
                const rel = `${pkg}/src/${relative(srcRoot, path).split(sep).join('/')}`;
                const matches = readFileSync(path, 'utf8').match(EFFECT_IMPORT);
                if (matches) {
                    violations.push(
                        `${rel}: ${matches.join(', ')} — Effect may not cross the port; ` +
                            `move the effectful code into server-cf (ADR 0015).`
                    );
                }
            }
        }
        expect(violations, violations.join('\n')).toEqual([]);
    });

    it('protocol and client package.json declare no effect dependencies', () => {
        const violations: string[] = [];
        for (const pkg of GUARDED_PACKAGES) {
            const manifest = JSON.parse(
                readFileSync(join(PACKAGES_ROOT, pkg, 'package.json'), 'utf8')
            );
            for (const field of [
                'dependencies',
                'devDependencies',
                'peerDependencies',
                'optionalDependencies',
            ]) {
                for (const dep of Object.keys(manifest[field] ?? {})) {
                    if (dep === 'effect' || dep.startsWith('@effect/')) {
                        violations.push(
                            `${pkg}/package.json ${field} declares "${dep}" — ` +
                                `Effect is backend-only (ADR 0015 Decision A).`
                        );
                    }
                }
            }
        }
        expect(violations, violations.join('\n')).toEqual([]);
    });
});
