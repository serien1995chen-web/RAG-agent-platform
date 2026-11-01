import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['test/e2e/**/*.pw.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    hookTimeout: 180_000,
    testTimeout: 90_000,
  },
});
