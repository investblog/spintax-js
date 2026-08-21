import { defineConfig } from 'tsup';

// Mirrors the core build: dual ESM + CJS with types. `@spintax/core` is a RUNTIME peer
// (`normalizeBaseLang` / `pluralArity` — see the header of src/index.ts for why the
// package gave up being dependency-free). tsup externalizes peer and dev dependencies,
// so nothing from the engine is bundled: the consumer installs `@spintax/core` itself
// and ends up with exactly one engine copy, the one its own code validates with.
export default defineConfig({
  entry: ['src/index.ts'],
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
