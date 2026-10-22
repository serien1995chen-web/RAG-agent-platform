#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildKnowledgeContractArtifacts,
  serializeArtifacts,
  validateContractClosure,
} from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const problems = validateContractClosure(repoRoot);
if (problems.length > 0) {
  console.error(`openapi:check 失败：契约闭包存在 ${problems.length} 项问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const artifacts = buildKnowledgeContractArtifacts(repoRoot);
const expected = serializeArtifacts(artifacts);
const stale = [];
for (const [relativePath, content] of Object.entries(expected)) {
  const path = join(repoRoot, relativePath);
  let actual;
  try {
    actual = readFileSync(path, 'utf8');
  } catch {
    stale.push(`${relativePath}: 文件不存在`);
    continue;
  }
  if (actual !== content) stale.push(`${relativePath}: 内容与生成结果不一致`);
}

if (stale.length > 0) {
  console.error('openapi:check 失败：快照或 registry 已过期，请执行 pnpm openapi:generate');
  for (const item of stale) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `openapi:check 通过：${artifacts.actualCounts.paths} paths、` +
    `${artifacts.actualCounts.operations} operations、` +
    `${artifacts.actualCounts.schemas} schemas；runtime 46、deferred 74`,
);
