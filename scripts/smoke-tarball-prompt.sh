#!/usr/bin/env bash
# Pack @spintax/authoring-prompt, install the tarball into a throwaway project next to a
# LOCALLY packed @spintax/core, and prove the packed artifact works the way a pipeline
# consumes it: require + import, then a real prompt build and a real clean.
#
# The engine is a PEER here — the third shape in this repo. The n8n node bundles it
# (its smoke asserts a zero-dep manifest), @spintax/mcp depends on it (its smoke asserts
# exactly one dependency), and the prompt declares it as a peer so the host ends up with
# ONE engine copy — the one it validates with. So this script asserts: no dependencies,
# exactly one peer, and that the peer resolves to the engine we just packed.
#
# Local pack rather than the registry for the same reason as the mcp smoke: the peer range
# may legitimately name an engine version that is not on npm yet, and proving the pair we
# are about to ship is the more useful claim anyway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/authoring-prompt"
CORE="$ROOT/packages/core"

# prepack builds a fresh dist and tsup prints to stdout, so don't capture pack's
# stdout — silence everything and locate the tarball by glob instead.
cd "$CORE"
npm pack >/dev/null 2>&1
CORE_TARBALL="$(ls -t "$CORE"/spintax-core-*.tgz 2>/dev/null | head -1)"
[ -n "$CORE_TARBALL" ] || { echo "npm pack produced no @spintax/core tarball"; exit 1; }

cd "$PKG"
npm pack >/dev/null 2>&1
TARBALL="$(ls -t "$PKG"/spintax-authoring-prompt-*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { echo "npm pack produced no tarball"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TARBALL" "$CORE_TARBALL"' EXIT
cp "$TARBALL" "$TMP/pkg.tgz"
cp "$CORE_TARBALL" "$TMP/core.tgz"

cd "$TMP"
npm init -y >/dev/null 2>&1
# Core first and explicitly: a peer is not auto-installed from a local tarball the way a
# dependency is, and if the peer range excludes the packed core npm refuses right here —
# which is the check this line replaces, moved earlier rather than dropped.
npm install ./core.tgz ./pkg.tgz >install.log 2>&1 || { cat install.log; echo "install failed — does the peer range admit the packed core?"; exit 1; }
SMOKE_CORE_VERSION="$(node -p "require('$ROOT/packages/core/package.json').version")"
export SMOKE_CORE_VERSION

node -e "const p=require('@spintax/authoring-prompt'); if(typeof p.buildAuthoringPrompt!=='function'){console.error('CJS entry missing buildAuthoringPrompt');process.exit(1)} console.log('  CJS require ok')"
node --input-type=module -e "import('@spintax/authoring-prompt').then(p=>{ if(p.PROMPT_VERSION!=='2'){console.error('ESM entry: PROMPT_VERSION is '+p.PROMPT_VERSION+', expected 2');process.exit(1)} console.log('  ESM import ok') })"

node -e "
const assert = require('node:assert');

const pkg = require('@spintax/authoring-prompt/package.json');
// A peer, not a dependency and not a bundle — see the header of this script.
assert.deepStrictEqual(Object.keys(pkg.dependencies ?? {}), []);
assert.deepStrictEqual(Object.keys(pkg.peerDependencies ?? {}), ['@spintax/core']);
// The RANGE is pinned too, not just the key: a narrowing to ^0.6.0 would still admit the packed
// core and pass every other line here, while silently breaking the open-above contract the
// CHANGELOG promises. Moving it is a documented decision (CHANGELOG + RELEASING.md), not a drift.
assert.strictEqual(pkg.peerDependencies['@spintax/core'], '>=0.2.0');

// The peer resolves from the INSTALLED tree and is the engine we just packed — not a stale
// registry release npm chose because the declared range excluded the local pack.
const dir = require('node:path').dirname(require.resolve('@spintax/authoring-prompt/package.json'));
const engine = require(require.resolve('@spintax/core/package.json', { paths: [dir] }));
assert.strictEqual(
  engine.version,
  process.env.SMOKE_CORE_VERSION,
  'the prompt package resolved @spintax/core ' + engine.version + ', not the packed ' + process.env.SMOKE_CORE_VERSION,
);

const { buildAuthoringPrompt, buildRepairPrompt, cleanModelTemplate, promptExamples, PROMPT_VERSION } = require('@spintax/authoring-prompt');
const { validate } = require('@spintax/core');

// A real build, in a 3-form locale so the arity actually crosses the peer boundary.
const built = buildAuthoringPrompt({ brief: 'smoke', locale: 'ru', allowedVariables: ['name', { name: 'city', case: 'genitive' }] });
assert.ok(built.systemPrompt.length > 500, 'systemPrompt must carry the rules');
assert.ok(built.userPrompt.includes('%city%'), 'userPrompt must carry the allow-list');
assert.deepStrictEqual(built.allowedVariables, ['name', 'city']);
assert.strictEqual(built.promptVersion, PROMPT_VERSION);

// The examples the prompt teaches from must validate under the same locale, with the packed engine.
for (const [k, ex] of Object.entries(promptExamples('ru'))) {
  const errs = validate(ex, { locale: 'ru' }).filter((d) => d.severity === 'error');
  assert.deepStrictEqual(errs, [], 'example ' + k + ' is invalid under ru: ' + JSON.stringify(errs));
}

const repair = buildRepairPrompt('{a|b', validate('{a|b'), { locale: 'ru' });
assert.ok(repair.userPrompt.includes('ERRORS:'), 'repair prompt must list the diagnostics');
assert.strictEqual(cleanModelTemplate('\`\`\`\n{a|b}\n\`\`\`'), '{a|b}');
console.log('  prompt build + examples validate + repair + clean from the installed artifact ok');
"

echo "authoring-prompt tarball smoke: OK"
