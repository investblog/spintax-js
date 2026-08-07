#!/usr/bin/env bash
# Pack n8n-nodes-spintax, install the tarball into a throwaway project, and prove
# the PUBLISHED artifact works the way n8n will consume it: require() the compiled
# node, and confirm the @spintax engines are BUNDLED (the manifest must carry zero
# runtime dependencies — n8n's verification rule — so the tarball must be
# self-sufficient apart from the n8n-workflow peer).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/n8n-node"

cd "$PKG"
npm pack >/dev/null 2>&1
TARBALL="$(ls -t "$PKG"/n8n-nodes-spintax-*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { echo "npm pack produced no tarball"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TARBALL"' EXIT
cp "$TARBALL" "$TMP/pkg.tgz"

cd "$TMP"
npm init -y >/dev/null 2>&1
# n8n-workflow is the peer the host provides; everything else must be inside.
# Pinned to 1.82.0 — the last line with no native transitive deps (2.x and late
# 1.x pull isolated-vm, which needs Node >= 22 and a compiler; the CI matrix
# still covers Node 18). The dist only needs NodeOperationError from it.
npm install ./pkg.tgz n8n-workflow@1.82.0 >/dev/null 2>&1

node -e "
const assert = require('node:assert');
const pkg = require('n8n-nodes-spintax/package.json');
assert.deepStrictEqual(pkg.dependencies ?? {}, {}, 'manifest must declare zero runtime dependencies');
const { Spintax } = require('n8n-nodes-spintax/' + pkg.n8n.nodes[0]);
const node = new Spintax();
assert.strictEqual(node.description.name, 'spintax');
assert.strictEqual(typeof node.execute, 'function');
const fs = require('node:fs');
const path = require('node:path');
const nodeDir = path.dirname(require.resolve('n8n-nodes-spintax/' + pkg.n8n.nodes[0]));
assert.ok(fs.existsSync(path.join(nodeDir, 'spintax.svg')), 'icon must ship next to the compiled node');
// Engine really bundled: a render round-trip with no @spintax/* install present.
const mock = {
  getInputData: () => [{ json: { name: 'Ada' } }],
  getNodeParameter: (k, i, d) => ({ operation: 'render', template: '{a|a} %name%', seed: '1' })[k] ?? d,
  continueOnFail: () => false,
  getNode: () => ({ name: 'Spintax' }),
};
node.execute.call(mock).then((r) => {
  assert.strictEqual(r[0][0].json.rendered, 'A Ada');
  console.log('  CJS require + bundled engine ok');
});
"

echo "n8n tarball smoke: OK"
