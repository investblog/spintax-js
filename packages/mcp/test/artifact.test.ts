/**
 * Guards on the BUILT artifact, not the source.
 *
 * The shared entry must stay free of `node:*` at runtime: the hosted server that
 * imports it is a Cloudflare Pages Function and that project has no `nodejs_compat`
 * flag anywhere. No compiler flag expresses this — `types: []` stops `process` and
 * `Buffer` from type-checking, but `import { readFileSync } from 'node:fs'` compiles
 * happily under `moduleResolution: Bundler`. So the rule is asserted on the bundle,
 * where the failure mode it prevents (a production deploy that dies at import time)
 * actually lives.
 */

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (file: string): string => join(pkgRoot, 'dist', file);
const built = existsSync(dist('index.js'));

describe('version', () => {
  it('matches package.json — the server must not misreport itself', () => {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(manifest.version);
  });
});

/** Both spellings, because the bundler is free to choose either — see below. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

/** `from 'x'`, `import 'x'`, `import('x')`, `require('x')`. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Walks the ENTRY's import graph, not just the entry file, and matches against the
 * real builtin list rather than the `node:` prefix. Two traps, both paid for here:
 *
 *   - tsup hoists shared code into `chunk-*.js`, so `dist/index.js` can be spotless
 *     while a chunk it imports pulls in the filesystem — which is exactly the deploy
 *     that dies at import time.
 *   - esbuild REWRITES `node:fs` to bare `fs` on the node platform. A guard that
 *     greps for "node:" therefore passes on a bundle that imports every builtin
 *     there is. The first version of this test did exactly that, and reported green.
 */
function nodeBuiltinsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const hits = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(dist(file), 'utf8');
    for (const m of source.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (BUILTINS.has(spec)) hits.add(spec);
      else if (/^\.\/[\w.-]+\.c?js$/.test(spec)) queue.push(spec.slice(2));
    }
  }
  return [...hits].sort();
}

describe.skipIf(!built)('the shared entry is node-free', () => {
  it.each(['index.js', 'index.cjs'])('nothing reachable from %s imports a node: builtin', file => {
    expect(nodeBuiltinsReachableFrom(file)).toEqual([]);
  });

  it('and the bin entry does reach the filesystem, so the walk is measuring something', () => {
    const hits = nodeBuiltinsReachableFrom('bin.js');
    expect(hits.some(h => h === 'fs' || h === 'node:fs')).toBe(true);
  });

  it('crosses at least one chunk boundary — otherwise the walk proves nothing', () => {
    expect(readFileSync(dist('index.js'), 'utf8')).toMatch(/["']\.\/[\w.-]+\.js["']/);
  });
});

if (!built) {
  // A silently skipped guard is worse than no guard: say it out loud.
  console.error(
    '[artifact.test] dist/ is missing — the node-free guard did NOT run. Run `npm run build -w @spintax/mcp` first.',
  );
}
