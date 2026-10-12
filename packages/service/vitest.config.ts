import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // MongoMemoryServer 用例会启动多个独立 mongod；限制文件并行度避免 CI 启动抖动。
    fileParallelism: false,
  },
});
