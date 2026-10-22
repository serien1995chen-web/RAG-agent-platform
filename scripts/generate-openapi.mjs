#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildKnowledgeContractArtifacts,
  serializeArtifacts,
} from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const artifacts = buildKnowledgeContractArtifacts(repoRoot);
const outputs = serializeArtifacts(artifacts);

for (const [relativePath, content] of Object.entries(outputs)) {
  const path = join(repoRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

console.log(
  `openapi:generate 完成：${artifacts.actualCounts.paths} paths、` +
    `${artifacts.actualCounts.operations} operations、` +
    `${artifacts.actualCounts.schemas} schemas；runtime 46、deferred 74`,
);
for (const relativePath of Object.keys(outputs)) console.log(`  - ${relativePath}`);
