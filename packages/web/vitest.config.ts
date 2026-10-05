import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 6 引入前端组件与 jsdom 依赖后再切换为 'jsdom'。
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
