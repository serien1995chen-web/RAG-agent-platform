#!/usr/bin/env node
/**
 * 生成 OpenAPI 3.1 文档与客户端类型（设计文档 12.8.1）。
 * 输出：packages/contracts/openapi/openapi.json、client-types.d.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildClientTypes,
  buildOpenApiDocument,
  validateContractClosure,
} from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const problems = validateContractClosure(repoRoot);
if (problems.length > 0) {
  console.error(`openapi:generate 失败：契约闭包存在 ${problems.length} 项问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const outDir = join(repoRoot, 'packages', 'contracts', 'openapi');
mkdirSync(outDir, { recursive: true });

const document = buildOpenApiDocument(repoRoot);
const openApiPath = join(outDir, 'openapi.json');
writeFileSync(openApiPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const clientTypesPath = join(outDir, 'client-types.d.ts');
writeFileSync(clientTypesPath, buildClientTypes(repoRoot), 'utf8');

console.log(
  `openapi:generate 完成：${document['x-kb-contract'].routeCount} 条路由、` +
    `${document['x-kb-contract'].dtoCount} 个 DTO、${document['x-kb-contract'].errorCount} 个错误码`,
);
console.log(`  - ${join('packages', 'contracts', 'openapi', 'openapi.json')}`);
console.log(`  - ${join('packages', 'contracts', 'openapi', 'client-types.d.ts')}`);
