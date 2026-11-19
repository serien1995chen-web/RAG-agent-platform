import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/performance/**/*.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    hookTimeout: 240_000,
    testTimeout: 240_000,
  },
});
