#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildKnowledgeContractArtifacts } from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  readFileSync(
    join(repoRoot, 'packages', 'contracts', 'src', 'knowledge', 'canonical-manifest.data.json'),
    'utf8',
  ),
);
const artifacts = buildKnowledgeContractArtifacts(repoRoot);
const routes = artifacts.fullRegistry.routes;
const problems = [];

const capabilityIds = manifest.capabilities.map((capability) => capability.id);
const uniqueCapabilityIds = new Set(capabilityIds);
if (manifest.capabilities.length !== 73) {
  problems.push(`Capability 应为 73，实际 ${manifest.capabilities.length}`);
}
if (uniqueCapabilityIds.size !== 73) {
  problems.push(`Capability ID 应唯一，实际 ${uniqueCapabilityIds.size}`);
}
const statusCounts = manifest.capabilities.reduce((counts, capability) => {
  counts[capability.status] = (counts[capability.status] ?? 0) + 1;
  return counts;
}, {});
if (statusCounts.BASE !== 12) problems.push(`BASE 应为 12，实际 ${statusCounts.BASE ?? 0}`);
if (statusCounts.DATA !== 57) problems.push(`DATA 应为 57，实际 ${statusCounts.DATA ?? 0}`);
if (statusCounts.EXCLUDED !== 4) {
  problems.push(`EXCLUDED 应为 4，实际 ${statusCounts.EXCLUDED ?? 0}`);
}

const routedCapabilities = new Set(routes.flatMap((route) => route.capabilityIds));
for (const capability of manifest.capabilities) {
  if (capability.status === 'EXCLUDED' && routedCapabilities.has(capability.id)) {
    problems.push(`EXCLUDED Capability 被 operation 引用: ${capability.id}`);
  }
  if (capability.status !== 'EXCLUDED' && !routedCapabilities.has(capability.id)) {
    problems.push(`Capability 未关联 operation: ${capability.id}`);
  }
}

if (manifest.mongoCollections.length !== 23) {
  problems.push(`Mongo 集合应为 23，实际 ${manifest.mongoCollections.length}`);
}
if (new Set(manifest.mongoCollections).size !== manifest.mongoCollections.length) {
  problems.push('Mongo 集合存在重复');
}
for (const collection of manifest.mongoCollections) {
  if (!collection.startsWith('knowledge_')) problems.push(`非 canonical Mongo 集合: ${collection}`);
}

if (manifest.queues.length !== 13) {
  problems.push(`BullMQ 队列应为 13，实际 ${manifest.queues.length}`);
}
if (new Set(manifest.queues).size !== manifest.queues.length) problems.push('BullMQ 队列存在重复');
for (const queue of manifest.queues) {
  if (!queue.startsWith('knowledge-')) problems.push(`非 canonical BullMQ 队列: ${queue}`);
}

if (manifest.vectorProfiles.length !== 4) {
  problems.push(`vector profile 应为 4，实际 ${manifest.vectorProfiles.length}`);
}
const expectedProfiles = new Map([
  [768, 'vector'],
  [1024, 'vector'],
  [1536, 'vector'],
  [3072, 'halfvec'],
]);
for (const profile of manifest.vectorProfiles) {
  if (expectedProfiles.get(profile.dimension) !== profile.storageType) {
    problems.push(`vector profile 维度/存储不匹配: ${profile.dimension}/${profile.storageType}`);
  }
}

if (problems.length > 0) {
  console.error(`knowledge:inventory 失败：${problems.length} 项`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      capabilities: {
        total: manifest.capabilities.length,
        base: statusCounts.BASE,
        data: statusCounts.DATA,
        excluded: statusCounts.EXCLUDED,
      },
      contract: artifacts.actualCounts,
      runtime: artifacts.runtimeRegistry.count,
      deferred: artifacts.deferredManifest.count,
      mongoCollections: manifest.mongoCollections.length,
      vectorProfiles: manifest.vectorProfiles.length,
      queues: manifest.queues.length,
    },
    null,
    2,
  ),
);
