#!/usr/bin/env node
/**
 * 生成 demo 用的路由清单（禁止手抄 87 条）。
 * 数据源：packages/contracts/src/openapi/route-registry.data.json
 * 产物：projects/app/src/demo/kb/lib/route-list.generated.ts
 *
 * 用法：node scripts/generate-demo-routes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(
  fs.readFileSync(
    path.join(root, 'packages/contracts/src/openapi/route-registry.data.json'),
    'utf8',
  ),
);

const rows = registry.routes.map((route) => ({
  routeId: route.routeId,
  method: route.method,
  path: route.path,
  group: route.group,
  implemented: route.implemented,
  source: route.source,
}));

const body = `/**
 * 自动生成，请勿手改。
 * 生成命令：node scripts/generate-demo-routes.mjs
 * 数据源：packages/contracts/src/openapi/route-registry.data.json
 * 路由数：${rows.length}
 */
import type { RouteEntry } from '../types';

export const DEMO_ROUTES: readonly RouteEntry[] = ${JSON.stringify(rows, null, 2)} as const;
`;

const out = path.join(root, 'projects/app/src/demo/kb/lib/route-list.generated.ts');
fs.writeFileSync(out, body, 'utf8');
console.log(`generated ${rows.length} routes -> ${path.relative(root, out)}`);
