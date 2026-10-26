#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

if (runtimeIds.length !== RUNTIME_OPERATION_IDS.length) {
  problems.push(`runtime 应为 ${RUNTIME_OPERATION_IDS.length}，实际 ${runtimeIds.length}`);
}
const expectedDeferredCount = fullIds.size - RUNTIME_OPERATION_IDS.length;
if (deferredIds.length !== expectedDeferredCount) {
  problems.push(`deferred 应为 ${expectedDeferredCount}，实际 ${deferredIds.length}`);
}
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
const apiRoot = join(pagesRoot, 'api');
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

const allowedApiPages = new Set([
  'console/session.ts',
  'healthz.ts',
  'readyz.ts',
  join('v1', 'knowledge', '[...path].ts'),
]);
for (const file of pageFiles) {
  const relativeApiPath = relative(apiRoot, file);
  if (!relativeApiPath.startsWith('..') && !allowedApiPages.has(relativeApiPath)) {
    problems.push(`未批准的 API page 仍存在: ${relativeApiPath}`);
  }
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

const runtimeRoots = [
  join(repoRoot, 'packages', 'contracts', 'src'),
  join(repoRoot, 'packages', 'dal', 'src'),
  join(repoRoot, 'packages', 'service', 'src'),
  join(repoRoot, 'projects', 'app', 'src'),
];
const runtimeSourceFiles = runtimeRoots.flatMap((root) => walk(root));
const forbiddenSourceFragments = [
  '/api/core/dataset',
  '/api/internal/dataset',
  '/api/admin/dataset',
  '/proApi/core/dataset',
  'dataset_collections',
  'dataset_datas',
  'dataset_trainings',
  'dataset_acl',
  'dataset_tags',
  'dataset_migrations',
  'dataset-delete',
  'dataset-parse',
  'dataset-sync',
  'collectionFilterMatch',
  'parseCollectionFilterMatch',
  'collectionId',
  'modeldata',
  'VECTOR(1536)',
  'SKELETON_NOT_IMPLEMENTED',
  '501999',
];
for (const file of runtimeSourceFiles) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const relativeFile = relative(repoRoot, file);
  for (const fragment of forbiddenSourceFragments) {
    if (content.includes(fragment)) {
      problems.push(`${relativeFile} 含旧 canonical 或占位片段: ${fragment}`);
    }
  }
}

const forbiddenModuleDirectories = [
  'collection',
  'delete',
  'index',
  'item',
  'knowledge-base',
  'migration',
  'permission',
  'processing',
];
for (const directory of forbiddenModuleDirectories) {
  const path = join(repoRoot, 'packages', 'service', 'src', 'modules', directory);
  if (existsSync(path) && statSync(path).isDirectory()) {
    problems.push(`旧 service module 仍存在: ${directory}`);
  }
}

const knowledgeCatchAll = join(apiRoot, 'v1', 'knowledge', '[...path].ts');
if (!existsSync(knowledgeCatchAll)) {
  problems.push('缺少唯一 canonical knowledge catch-all');
}
for (const file of pageFiles) {
  if (file !== knowledgeCatchAll && file.includes('[...') && relative(apiRoot, file) !== file) {
    problems.push(`发现未批准 catch-all: ${relative(repoRoot, file)}`);
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
