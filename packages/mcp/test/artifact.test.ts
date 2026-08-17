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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
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

  it('runs the engine from THIS repo, not a stale nested copy', () => {
    // Paid for: bumping the dependency to ^0.4.0 left a 0.3.4 tree behind in
    // packages/mcp/node_modules/@spintax/core, which takes precedence over the
    // workspace link. The suite then tested this package against an engine the
    // repository had already moved past — green, and meaningless. `npm install`
    // does not always prune it, so assert it instead of remembering.
    // realpathSync because the workspace link resolves through root node_modules;
    // comparing the symlinked path would pass for a nested copy too.
    //
    // Case-folded on win32, and note that this is the OPPOSITE of the rule in
    // include-root.ts, for a reason: there, two differently-cased directories can
    // genuinely be different directories (per-directory case sensitivity), and an
    // untrusted ref must not slip between them. Here both strings name one known
    // directory — vitest reports `W:\Projects\…` from import.meta.url while
    // require.resolve returns `W:\projects\…`, and treating those as different is
    // how this guard failed on its first run.
    const canon = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
    const resolved = canon(realpathSync(createRequire(import.meta.url).resolve('@spintax/core')));
    expect(resolved.startsWith(canon(realpathSync(join(pkgRoot, '..', 'core'))) + sep)).toBe(true);

    const core = JSON.parse(
      readFileSync(join(pkgRoot, '..', 'core', 'package.json'), 'utf8'),
    ) as { version: string };
    const range = (
      JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['@spintax/core']!;
    // The declared range must admit the workspace engine, or a published install
    // resolves to something this suite never ran.
    expect(range.replace(/^[^\d]*/, '').split('.')[0]).toBe(core.version.split('.')[0]);
    expect(Number(range.replace(/^[^\d]*/, '').split('.')[1])).toBeLessThanOrEqual(
      Number(core.version.split('.')[1]),
    );
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
