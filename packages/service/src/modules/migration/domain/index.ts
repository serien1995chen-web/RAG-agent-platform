/**
 * MigrationRun 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export interface MigrationRun {
  runId: string;
  teamId: string;
  version: string;
  state: string;
  cursor: string | null;
}

export const MIGRATION_RUN_INVARIANTS = [
  'teamId 必填且不可随请求覆盖',
  '跨对象引用必须同租户',
] as const;

export function validateMigrationRun(candidate: Partial<MigrationRun>): string[] {
  const issues: string[] = [];
  if (!candidate.teamId) issues.push('teamId 必填且不可随请求覆盖');
  if (!candidate.version) issues.push('version 必须为已登记迁移版本');
  return issues;
}
