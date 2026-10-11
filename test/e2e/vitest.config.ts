import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@kb/contracts': resolvePath('../../packages/contracts/src/index.ts'),
      '@kb/parse': resolvePath('../../packages/parse/src/index.ts'),
      '@kb/chunk': resolvePath('../../packages/chunk/src/index.ts'),
      '@kb/qa': resolvePath('../../packages/qa/src/index.ts'),
      '@kb/service': resolvePath('../../packages/service/src/index.ts'),
      '@kb/dal': resolvePath('../../packages/dal/src/index.ts'),
    },
  },
  test: { environment: 'node', include: ['*.test.ts'], passWithNoTests: true },
});
