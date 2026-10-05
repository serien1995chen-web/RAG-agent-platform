import type { ProcessingJobSnapshot } from '../../../ports/types';
/**
 * ProcessingJob 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type ProcessingJob = ProcessingJobSnapshot;

export const PROCESSING_JOB_INVARIANTS = [
  'teamId 必填且不可随请求覆盖',
  '跨对象引用必须同租户',
] as const;

export function validateProcessingJob(candidate: Partial<ProcessingJob>): string[] {
  const issues: string[] = [];
  if (!candidate.teamId) issues.push('teamId 必填且不可随请求覆盖');
  if (!candidate.mode) issues.push('mode 必须属于已登记任务模式');
  return issues;
}
