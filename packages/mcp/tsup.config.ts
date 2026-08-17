import { defineConfig } from 'tsup';

// Mirrors the core build: dual ESM + CJS with types. `@spintax/core` is a real
// runtime dependency here (NOT bundled, unlike the n8n node) so a host installing
// both this and the engine ends up with one copy — tsup externalizes dependencies
// by default, which is exactly what we want.
//
// Two entries: `index` is the transport-free module the hosted Cloudflare Function
// imports, and `bin` is the executable. The stdio transport is deliberately NOT a
// third entry or a public subpath — the executable is its only consumer, and a
// `./stdio` export would be an API to support forever for a host nobody has asked
// for yet (spec §9.3: promote on a consumer-driven reason). Adding it later is not a
// breaking change; removing it would be.
//
// A single config means a CJS twin of `bin` also lands in dist; it is a few hundred
// bytes and nothing references it, which is cheaper than sequencing two configs where
// the second one's `clean` could race the first one's output.
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  treeshake: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
