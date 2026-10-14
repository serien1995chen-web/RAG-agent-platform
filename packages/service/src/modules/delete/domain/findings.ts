/**
 * 对账领域类型（P6-03 / 设计 14.7 / 16.3 / AB §4.2）：
 * finding 仅保存样本 ID 与哈希，不保存任何正文。
 */

export const RECONCILE_FINDING_KINDS = [
  'vector-orphan',
  'fulltext-orphan',
  's3-orphan',
  'stuck-delete-job',
  'acl-orphan',
  'training-orphan',
  'scheduler-diff',
  'cross-store-failed',
] as const;

export type ReconcileFindingKind = (typeof RECONCILE_FINDING_KINDS)[number];

/** 固定动作词汇：dry-run 只报告，apply 仅按稳定幂等键清理可证明孤儿。 */
export const RECONCILE_FINDING_ACTIONS = [
  'report',
  'cleanup',
  'requeue',
  'backfill',
  'pending_review',
  'audit',
  'pending_compensation',
] as const;

export interface ReconcileFinding {
  kind: ReconcileFindingKind;
  sampleId: string;
  hash: string;
  action: string;
}

export type ReconcileMode = 'dry-run' | 'apply';

/** S3 对象描述：仅 id/元数据，不含对象正文。 */
export interface S3ObjectDescriptor {
  key: string;
  size: number;
  lastModified: Date | null;
}

/** 孤儿对象枚举（bootstrap 按 MinioObjectStore 判型注入；缺省时 S3 规则转 pending_review）。 */
export interface S3OrphanScanner {
  listByPrefix(input: { prefix: string; limit: number }): Promise<S3ObjectDescriptor[]>;
}

/** Scheduler 对账只读汇总（P3-02 Reconcile；删除未知调度动作仍归 P3-02）。 */
export interface SchedulerReconcileSummary {
  created: number;
  dropped: number;
  skipped_missing: number;
  skipped_mismatch: number;
  error: number;
}
