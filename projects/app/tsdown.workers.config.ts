import { defineConfig } from 'tsdown';

/**
 * P3-07：`build:workers` 真实构建入口（设计 5.4 / 6.3 / 18.11）。
 * - 打包 @kb/* workspace TS 源码，避免产物在运行时解析 TS 源；
 * - npm 依赖保持外部（由部署环境的 node_modules 提供）；
 * - ESM / platform=node / 目标对齐 tsconfig.base.json（ES2023）；
 * - 不生成 dts、生成 sourcemap、构建前清理输出目录。
 */
export default defineConfig({
  entry: { worker: 'src/runtime/knowledge-worker.ts' },
  outDir: 'dist/workers',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: [
      "import { createRequire as __kbCreateRequire } from 'node:module';",
      "import __kbModule from 'node:module';",
      "import { fileURLToPath as __kbFileURLToPath } from 'node:url';",
      "import { dirname as __kbDirname } from 'node:path';",
      "import { delimiter as __kbDelimiter, join as __kbJoin } from 'node:path';",
      'var __filename = __kbFileURLToPath(import.meta.url);',
      'var __dirname = __kbDirname(__filename);',
      "var __kbWorkspaceRoot = __kbJoin(__dirname, '../../../..');",
      "process.env.NODE_PATH = [__kbJoin(__kbWorkspaceRoot, 'packages/service/node_modules'), __kbJoin(__kbWorkspaceRoot, 'packages/parse/node_modules'), __kbJoin(__kbWorkspaceRoot, 'packages/qa/node_modules'), __kbJoin(__kbWorkspaceRoot, 'packages/chunk/node_modules'), __kbJoin(__kbWorkspaceRoot, 'sdk/storage/node_modules'), __kbJoin(__kbWorkspaceRoot, 'node_modules/.pnpm/node_modules'), __kbJoin(__kbWorkspaceRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(__kbDelimiter);",
      '__kbModule._initPaths();',
      'var require = __kbCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  copy: [
    {
      from: '../../packages/service/node_modules/@node-rs/jieba/dict.txt',
      to: 'dist/workers',
    },
    {
      from: '../../packages/service/node_modules/@node-rs/jieba/idf.txt',
      to: 'dist/workers',
    },
  ],
  deps: {
    alwaysBundle: [/^@kb\//],
    neverBundle: ['ali-oss', 'cos-nodejs-sdk-v5'],
  },
});
