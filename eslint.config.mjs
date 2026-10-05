import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const infraModules = ['mongoose', 'pg', 'ioredis', 'bullmq', 'minio', 'next'];
const infraPatterns = [
  ...infraModules,
  '@aws-sdk/*',
  '@opentelemetry/*',
  'pino',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/artifacts/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'projects/*/src/**/*.ts', 'sdk/*/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: '业务代码不得直接读取 process.env（设计文档 18.5）；请通过配置层读取。',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
          message: '业务代码禁止 throw new Error，必须使用统一错误工厂（设计文档 18.6）。',
        },
      ],
    },
  },
  {
    files: ['packages/service/src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: infraPatterns,
              message: 'domain 层禁止依赖基础设施客户端（设计文档 18.2）。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/service/src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: infraPatterns,
              message: 'application 层禁止直接依赖基础设施客户端（设计文档 18.2）。',
            },
            {
              group: ['**/repository/**', '**/adapter/**', '**/jobs/**'],
              message: 'application 不得直接导入具体实现，必须依赖 Port（设计文档 18.2）。',
            },
          ],
        },
      ],
    },
  },
  {
    // 配置层是唯一允许读取环境变量的位置（设计文档 18.5）。
    files: ['packages/service/src/shared/config/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
