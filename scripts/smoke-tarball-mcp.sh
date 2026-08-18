#!/usr/bin/env bash
# Pack @spintax/mcp, install the tarball into a throwaway project, and prove the
# packed artifact works the way an MCP client consumes it: run the `bin` over
# stdio and read a tools/list back.
#
# This is the gate that matters most for this package, because it is the first one in
# the repo with a `bin`. One command exercises the shebang, the bin field, the exports
# map, the dual ESM/CJS entries and — unlike the n8n node, which bundles the engine —
# real resolution of @spintax/core as a DEPENDENCY.
#
# The engine is installed from a LOCAL tarball, not the registry. It used to come from
# the registry, which quietly made this gate un-passable for a whole release: the mcp
# manifest must name the core version it is being shipped against, and that version is
# not on npm until core is released — while pinning the PREVIOUS range instead makes npm
# nest a stale engine under packages/mcp, which the artifact guard (correctly) fails. Both
# doors locked. Packing both means this proves the pair we are about to ship, at any point
# in the cycle, which is the more useful claim anyway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/mcp"
CORE="$ROOT/packages/core"

# prepack builds a fresh dist and tsup prints to stdout, so don't capture pack's
# stdout — silence everything and locate the tarball by glob instead.
cd "$CORE"
npm pack >/dev/null 2>&1
CORE_TARBALL="$(ls -t "$CORE"/spintax-core-*.tgz 2>/dev/null | head -1)"
[ -n "$CORE_TARBALL" ] || { echo "npm pack produced no @spintax/core tarball"; exit 1; }

cd "$PKG"
npm pack >/dev/null 2>&1
TARBALL="$(ls -t "$PKG"/spintax-mcp-*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { echo "npm pack produced no tarball"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TARBALL" "$CORE_TARBALL"' EXIT
cp "$TARBALL" "$TMP/pkg.tgz"
cp "$CORE_TARBALL" "$TMP/core.tgz"

cd "$TMP"
npm init -y >/dev/null 2>&1
# Core first and explicitly, so the mcp manifest's range is satisfied by the build under
# test. If the range and the packed core disagree, npm says so here — which is the check
# this line replaces, moved earlier rather than dropped.
npm install ./core.tgz ./pkg.tgz >/dev/null 2>&1
SMOKE_CORE_VERSION="$(node -p "require('$ROOT/packages/core/package.json').version")"
export SMOKE_CORE_VERSION

node -e "const s=require('@spintax/mcp'); if(typeof s.createDispatcher!=='function'){console.error('CJS entry missing createDispatcher');process.exit(1)} console.log('  CJS require ok')"
node --input-type=module -e "import('@spintax/mcp').then(s=>{ if(typeof s.buildTools!=='function'){console.error('ESM entry missing buildTools');process.exit(1)} console.log('  ESM import ok') })"

node -e "
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pkg = require('@spintax/mcp/package.json');
// The engine is a real dependency here, NOT bundled — that is the whole point of
// this package existing alongside the n8n node, whose smoke asserts the opposite.
assert.deepStrictEqual(Object.keys(pkg.dependencies ?? {}), ['@spintax/core']);
assert.strictEqual(typeof pkg.bin, 'object');
const binName = Object.keys(pkg.bin)[0];
assert.strictEqual(binName, 'spintax-mcp');

const dir = path.dirname(require.resolve('@spintax/mcp/package.json'));
const bin = path.join(dir, pkg.bin[binName]);
assert.ok(fs.existsSync(bin), 'the bin file must ship in the tarball');
assert.ok(fs.readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node'), 'the bin needs its shebang');
// The engine resolves from the INSTALLED tree, not from this repo — AND it is the
// engine we just packed. Proving only that *some* core resolves would pass against a
// stale registry release npm chose because the declared range excluded the local pack,
// which is the exact failure this script was rewritten to catch.
const engine = require(require.resolve('@spintax/core/package.json', { paths: [dir] }));
assert.strictEqual(
  engine.version,
  process.env.SMOKE_CORE_VERSION,
  'the mcp package resolved @spintax/core ' + engine.version + ', not the packed ' + process.env.SMOKE_CORE_VERSION,
);

const child = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => { out += c; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { err += c; });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'render_spintax', arguments: { template: '{a|a} %who%', context: { who: 'Ada' }, count: 1, seed: 1 } },
}) + '\n');
child.stdin.end();
const timer = setTimeout(() => { child.kill(); throw new Error('the server did not answer in time'); }, 20000);
child.on('exit', (code) => {
  clearTimeout(timer);
  assert.strictEqual(code, 0, 'the server must exit 0 on stdin EOF');
  assert.strictEqual(err, '', 'stderr must be empty on a clean run');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.strictEqual(lines.length, 2, 'two requests, two lines: got ' + lines.length);
  const list = JSON.parse(lines[0]);
  assert.deepStrictEqual(list.result.tools.map((t) => t.name),
    ['validate_spintax', 'render_spintax', 'analyze_spintax']);
  // No template cap on the local server: the property must be absent, not large.
  assert.ok(!('maxLength' in list.result.tools[0].inputSchema.properties.template));
  const call = JSON.parse(lines[1]);
  assert.strictEqual(call.result.isError, false);
  assert.deepStrictEqual(call.result.structuredContent.variants, ['A Ada']);
  console.log('  bin over stdio: tools/list + render from the installed artifact ok');
});
"

echo "mcp tarball smoke: OK"
