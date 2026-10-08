import { defineConfig } from 'tsdown';

/**
 * P3-07：`build:workers` 真实构建入口（设计 5.4 / 6.3 / 18.11）。
 * - 打包 @kb/* workspace TS 源码，避免产物在运行时解析 TS 源；
 * - npm 依赖保持外部（由部署环境的 node_modules 提供）；
 * - ESM / platform=node / 目标对齐 tsconfig.base.json（ES2023）；
 * - 不生成 dts、生成 sourcemap、构建前清理输出目录。
 */
export default defineConfig({
  entry: { worker: 'src/runtime/worker.ts' },
  outDir: 'dist/workers',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: [/^@kb\//],
  },
});
