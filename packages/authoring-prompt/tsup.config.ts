import { defineConfig } from 'tsup';

// Mirrors the core build: dual ESM + CJS with types. `@spintax/core` is a type-only import
// here, so nothing from the engine is bundled and the package ships zero runtime deps.
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
