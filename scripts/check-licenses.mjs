#!/usr/bin/env node
// License-matrix gate (ADR-0016 §C / open question "SPDX + license-check CI").
//
// Asserts the per-package licensing can't silently drift as packages are
// added: every workspace under packages/* and apps/* must declare a
// `license` field AND ship a LICENSE file, and the value must match the
// ADR-0016 matrix — Apache-2.0 for the open engine (packages/*), PolyForm
// Shield 1.0.0 (source-available) for the frontends (apps/*).
//
// Pure Node, no deps; runnable locally (`npm run licenses:check`) or in CI.

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// tier dir → required SPDX license id (ADR-0016 license matrix).
const MATRIX = {
	packages: 'Apache-2.0',
	apps: 'PolyForm-Shield-1.0.0',
};

const problems = [];

// Discover the workspace tiers from the root package.json `workspaces`
// field — the single source of truth — instead of hardcoding them, so a
// new tier (e.g. "libs/*") can't silently escape the gate. Each tier must
// have a MATRIX rule; an unknown tier fails closed rather than passing
// unchecked.
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const tierDirs = [...new Set((rootPkg.workspaces ?? []).map((ws) => ws.split('/')[0]))];

for (const tierDir of tierDirs) {
	const expected = MATRIX[tierDir];
	if (!expected) {
		problems.push(
			`workspace tier "${tierDir}/" has no ADR-0016 license rule — add it to the MATRIX in scripts/check-licenses.mjs.`
		);
		continue;
	}

	const tierPath = join(repoRoot, tierDir);
	if (!existsSync(tierPath)) continue;

	for (const name of readdirSync(tierPath)) {
		const pkgDir = join(tierPath, name);
		if (!statSync(pkgDir).isDirectory()) continue;

		const pkgJsonPath = join(pkgDir, 'package.json');
		if (!existsSync(pkgJsonPath)) continue; // not a workspace package
		const rel = `${tierDir}/${name}`;

		const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

		if (!pkg.license) {
			problems.push(`${rel}: package.json is missing a "license" field (expected "${expected}").`);
		} else if (pkg.license !== expected) {
			problems.push(`${rel}: license is "${pkg.license}" but the ADR-0016 matrix requires "${expected}".`);
		}

		if (!existsSync(join(pkgDir, 'LICENSE'))) {
			problems.push(`${rel}: missing a LICENSE file.`);
		}
	}
}

// Repository defaults: root LICENSE (Apache-2.0) + NOTICE must exist.
for (const f of ['LICENSE', 'NOTICE']) {
	if (!existsSync(join(repoRoot, f))) problems.push(`root: missing ${f}.`);
}

if (problems.length > 0) {
	console.error('License matrix check FAILED (ADR-0016):\n');
	for (const p of problems) console.error(`  - ${p}`);
	console.error('\nFix: add the LICENSE file and/or the matching `license` field.');
	process.exit(1);
}

console.log('License matrix check passed: every packages/* is Apache-2.0 and every apps/* is PolyForm-Shield-1.0.0, each with a LICENSE file.');
