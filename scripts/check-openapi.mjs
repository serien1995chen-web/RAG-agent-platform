#!/usr/bin/env node
/**
 * OpenAPI 快照对比与契约闭包门禁（设计文档 12.8.1）。
 * 与 pnpm openapi:generate 使用同一组装入口，未登记差异即失败。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildOpenApiDocument,
  validateContractClosure,
} from '../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const problems = validateContractClosure(repoRoot);
if (problems.length > 0) {
  console.error(`openapi:check 失败：契约闭包存在 ${problems.length} 项问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const snapshotPath = join(repoRoot, 'packages', 'contracts', 'openapi', 'openapi.json');
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
} catch {
  console.error(`openapi:check 失败：缺少快照 ${snapshotPath}，请先执行 pnpm openapi:generate`);
  process.exit(1);
}

const current = buildOpenApiDocument(repoRoot);
const currentText = JSON.stringify(current, null, 2);
const snapshotText = JSON.stringify(snapshot, null, 2);
if (currentText !== snapshotText) {
  console.error(
    'openapi:check 失败：OpenAPI 快照与当前契约不一致，请执行 pnpm openapi:generate 并评审差异。',
  );
  process.exit(1);
}

const contract = current['x-kb-contract'];
console.log(
  `openapi:check 通过：快照一致；${contract.routeCount} 条路由（已实现 ${contract.implementedRoutes.length} 条）、` +
    `${contract.dtoCount} 个 DTO、${contract.errorCount} 个错误码。`,
);
