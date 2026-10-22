import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/tenant/**/*.test.ts'],
    fileParallelism: false,
  },
});
