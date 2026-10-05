import type { DeleteJobSnapshot } from '../../../ports/types';
/**
 * DeleteJob 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type DeleteJob = DeleteJobSnapshot;

export const DELETE_JOB_INVARIANTS = [
  'teamId 必填且不可随请求覆盖',
  '跨对象引用必须同租户',
] as const;

export function validateDeleteJob(candidate: Partial<DeleteJob>): string[] {
  const issues: string[] = [];
  if (!candidate.teamId) issues.push('teamId 必填且不可随请求覆盖');
  if (!candidate.state) issues.push('删除任务状态必须来自冻结状态机');
  return issues;
}
