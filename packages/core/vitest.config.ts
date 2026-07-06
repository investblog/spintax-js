import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The corpus lives in a sibling workspace; watch it so fixture edits re-run.
    watchExclude: ['**/dist/**', '**/node_modules/**'],
  },
});
