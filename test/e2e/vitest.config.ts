import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    // ISSUE-009：真栈与 mock-runtime 用例共用同一入口；未配置真实依赖时 real-stack 组显式跳过。
    include: ['*.test.ts', 'real-stack/*.test.ts'],
    passWithNoTests: true,
  },
});
