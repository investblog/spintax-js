#!/usr/bin/env bash
# Pack @spintax/core, install the tarball into a throwaway project, and prove the
# PUBLISHED artifact (not the source) imports + runs in both CJS and ESM. This is
# the end-to-end packaging gate: publint checks the manifest, attw checks type
# resolution, and this checks the runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/packages/core"

cd "$CORE"
# prepack builds a fresh dist and tsup prints to stdout, so don't capture pack's
# stdout — silence everything and locate the tarball by glob instead.
npm pack >/dev/null 2>&1
TARBALL="$(ls -t "$CORE"/spintax-core-*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { echo "npm pack produced no tarball"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TARBALL"' EXIT
cp "$TARBALL" "$TMP/pkg.tgz"

cd "$TMP"
npm init -y >/dev/null 2>&1
npm install ./pkg.tgz >/dev/null 2>&1

node -e "const s=require('@spintax/core'); if(s.render('{a|a}',{seed:1})!=='A'){console.error('CJS render mismatch');process.exit(1)} console.log('  CJS require ok')"
node --input-type=module -e "import('@spintax/core').then(s=>{ if(s.render('{b|b}',{seed:1})!=='B'){console.error('ESM render mismatch');process.exit(1)} console.log('  ESM import ok') })"

echo "tarball smoke: OK"
