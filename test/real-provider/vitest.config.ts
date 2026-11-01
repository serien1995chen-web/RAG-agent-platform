import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/real-provider/**/*.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
