import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // stdio-protocol.test.ts spawns the built bin and waits on real pipes; the
    // 5 s default is tight on a cold Windows filesystem.
    testTimeout: 20_000,
  },
});
