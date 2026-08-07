import { defineConfig } from 'tsup';

// CJS-only: n8n loads community nodes via require(). Both @spintax/* siblings
// are bundled INTO dist (n8n's verification rules forbid runtime dependencies,
// so the published manifest carries none) — only the host SDK stays external.
// noExternal is a guard, not the mechanism: tsup bundles devDeps by default, but
// would silently externalize @spintax/* the day someone moves them to
// `dependencies` — this pin keeps the bundle self-sufficient either way, and the
// smoke script (scripts/smoke-tarball-n8n.sh) asserts the zero-dep manifest.
export default defineConfig({
  entry: {
    'nodes/Spintax/Spintax.node': 'src/nodes/Spintax/Spintax.node.ts',
  },
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: false,
  target: 'es2022',
  noExternal: [/^@spintax\//],
  external: ['n8n-workflow'],
});
