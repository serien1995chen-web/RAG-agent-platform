#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  buildKnowledgeContractArtifacts,
  RUNTIME_OPERATION_IDS,
} from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const artifacts = buildKnowledgeContractArtifacts(repoRoot);
const { runtimeRegistry, deferredManifest, fullRegistry } = artifacts;
const problems = [];

const runtimeIds = runtimeRegistry.operations.map((operation) => operation.operationId);
const deferredIds = deferredManifest.operations.map((operation) => operation.operationId);
const fullIds = new Set(fullRegistry.routes.map((operation) => operation.operationId));
const runtimeSet = new Set(runtimeIds);
const deferredSet = new Set(deferredIds);

if (runtimeIds.length !== 46) problems.push(`runtime 应为 46，实际 ${runtimeIds.length}`);
if (deferredIds.length !== 74) problems.push(`deferred 应为 74，实际 ${deferredIds.length}`);
if (runtimeSet.size !== runtimeIds.length) problems.push('runtime operationId 存在重复');
if (deferredSet.size !== deferredIds.length) problems.push('deferred operationId 存在重复');
for (const operationId of runtimeIds) {
  if (deferredSet.has(operationId)) problems.push(`runtime/deferred 交集: ${operationId}`);
  if (!fullIds.has(operationId)) problems.push(`runtime 不在完整合同: ${operationId}`);
}
for (const operationId of deferredIds) {
  if (!fullIds.has(operationId)) problems.push(`deferred 不在完整合同: ${operationId}`);
}
if (runtimeIds.length + deferredIds.length !== fullIds.size) {
  problems.push('runtime/deferred 并集不等于完整合同');
}
for (const operationId of RUNTIME_OPERATION_IDS) {
  if (!runtimeSet.has(operationId)) problems.push(`批准 runtime 缺少 operation: ${operationId}`);
}
for (const operation of deferredManifest.operations) {
  if (!operation.stage) problems.push(`deferred 缺少计划阶段: ${operation.operationId}`);
  if (!operation.accId) problems.push(`deferred 缺少 ACC: ${operation.operationId}`);
  if (operation.targetSection !== '9.2') {
    problems.push(`deferred 缺少目标设计章节: ${operation.operationId}`);
  }
  if (operation.runtime !== false)
    problems.push(`deferred 被标记为 runtime: ${operation.operationId}`);
}

const pagesRoot = join(repoRoot, 'projects', 'app', 'src', 'pages');
function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

let pageFiles = [];
try {
  pageFiles = walk(pagesRoot);
} catch {
  problems.push('缺少 projects/app/src/pages');
}
const forbiddenPageFragments = [
  join('api', 'core'),
  join('api', 'internal', 'dataset'),
  join('api', 'admin', 'dataset'),
  join('api', 'proApi'),
];
for (const file of pageFiles) {
  const normalized = relative(pagesRoot, file);
  for (const fragment of forbiddenPageFragments) {
    if (normalized.includes(fragment)) problems.push(`旧 page route 仍存在: ${normalized}`);
  }
}

const runtimeEntryFiles = pageFiles
  .map((file) => relative(repoRoot, file))
  .filter((file) => file.includes(join('api', 'v1', 'knowledge')) || file.endsWith('.tsx'));
for (const file of runtimeEntryFiles) {
  let content;
  try {
    content = readFileSync(join(repoRoot, file), 'utf8');
  } catch {
    continue;
  }
  if (content.includes('SKELETON_NOT_IMPLEMENTED') || content.includes('501999')) {
    problems.push(`runtime page 含占位实现: ${file}`);
  }
}

if (problems.length > 0) {
  console.error(`knowledge:check-runtime 失败：${problems.length} 项`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `knowledge:check-runtime 通过：runtime ${runtimeIds.length}，deferred ${deferredIds.length}，` +
    '交集 0，并集 120，旧 page route 0',
);
