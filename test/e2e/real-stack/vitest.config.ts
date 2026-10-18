import { defineConfig } from 'vitest/config';

/** ISSUE-009：真栈 e2e 独立配置（真实 Mongo/PG/Redis/MinIO，不 mock 被测依赖）。 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
