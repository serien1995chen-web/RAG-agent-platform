import { isAbsolute, join, relative, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const workspaceRoot = resolve(import.meta.dirname, '../..');

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`S11_UI_BLOCKED: missing ${name}`);
  return value;
}

function assertOutsideWorktree(directory: string): string {
  const resolvedDirectory = resolve(directory);
  const pathFromRoot = relative(workspaceRoot, resolvedDirectory);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
    throw new Error(`S11_UI_EVIDENCE_DIR must be outside ${workspaceRoot}`);
  }
  return resolvedDirectory;
}

const baseURL = requiredEnvironment('S11_UI_BASE_URL');
const evidenceDirectory = assertOutsideWorktree(requiredEnvironment('S11_UI_EVIDENCE_DIR'));

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 's11-ui-matrix.pw.test.ts',
  outputDir: join(evidenceDirectory, 'playwright-artifacts'),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 600_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    locale: 'zh-CN',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },
});
