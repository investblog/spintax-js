import { defineConfig } from 'tsup';

// Dual ESM + CJS build with type declarations. Zero runtime deps, so nothing
// is bundled/externalized — the whole engine ships as one tree-shakeable module
// that runs unchanged on Cloudflare Workers, Node 18+, and in the browser.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  treeshake: true,
  // package.json has "type": "module", so ESM keeps ".js" and CJS gets ".cjs".
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
