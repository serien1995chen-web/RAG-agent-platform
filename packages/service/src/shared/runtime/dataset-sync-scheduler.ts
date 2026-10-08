import type { JobSchedulerJson, Queue } from 'bullmq';
import type { LeaderLock } from './leader-lock';

export interface DatasetSyncSchedulerLogger {
  log(event: string, fields: Record<string, unknown>): void;
}

export interface DatasetSyncSchedulerDeps {
  queue: Queue;
  lock: LeaderLock;
  /** E-1 方案 C：期望态由注入提供者给出，本阶段不做跨租户扫描。 */
  listExpectedDatasetIds: () => Promise<readonly string[]>;
  /** 显式删除态：仅命中该集合的调度会被移除；未提供时不做删除清理。 */
  listRemovedDatasetIds?: () => Promise<readonly string[]>;
  /** BullMQ 调度周期；默认 24 小时（设计文档 16.4）。 */
  intervalMs?: number;
  logger?: DatasetSyncSchedulerLogger;
}

/** 设计文档 16.4 的结果词汇。 */
export interface DatasetSyncSchedulerResult {
  created: number;
  dropped: number;
  skipped_missing: number;
  skipped_mismatch: number;
  error: number;
}

export const DEFAULT_DATASET_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DATASET_SYNC_SCHEDULER_JOB_NAME = 'sync';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function schedulerMatchesDataset(scheduler: JobSchedulerJson, datasetId: string): boolean {
  if (scheduler.name !== DATASET_SYNC_SCHEDULER_JOB_NAME) return false;
  const data = scheduler.template?.data;
  if (typeof data !== 'object' || data === null) return false;
  return (data as Record<string, unknown>)['datasetId'] === datasetId;
}

/**
 * Scheduler Reconcile（设计文档 9.13 / 16.4）：
 * - 期望态缺失则按稳定 datasetId 幂等 upsert；
 * - 仅显式删除态命中的调度会被移除；
 * - 未知调度一律保留（计入 skipped_mismatch，不计 dropped），模板不匹配只记录；
 * - 单条失败计入 error，不抛出整轮，下一轮重试。
 * 调用方负责持锁生命周期：持有锁（或本轮获取成功）才执行；释放由 scheduler 单元在 close 时完成。
 */
export async function reconcileDatasetSyncSchedulers(
  deps: DatasetSyncSchedulerDeps,
): Promise<DatasetSyncSchedulerResult> {
  const result: DatasetSyncSchedulerResult = {
    created: 0,
    dropped: 0,
    skipped_missing: 0,
    skipped_mismatch: 0,
    error: 0,
  };

  let lockHeld: boolean;
  try {
    lockHeld = deps.lock.isHeld() || (await deps.lock.acquire());
  } catch (error) {
    result.error += 1;
    deps.logger?.log('dataset-sync-scheduler.lock_failed', { error: errorName(error) });
    return result;
  }
  if (!lockHeld) {
    deps.logger?.log('dataset-sync-scheduler.round_skipped', { reason: 'lock_not_held' });
    return result;
  }

  const intervalMs = deps.intervalMs ?? DEFAULT_DATASET_SYNC_INTERVAL_MS;

  let expected: readonly string[];
  let removed: readonly string[];
  let schedulers: JobSchedulerJson[];
  try {
    expected = await deps.listExpectedDatasetIds();
    removed = (await deps.listRemovedDatasetIds?.()) ?? [];
    schedulers = await deps.queue.getJobSchedulers();
  } catch (error) {
    result.error += 1;
    deps.logger?.log('dataset-sync-scheduler.scan_failed', { error: errorName(error) });
    return result;
  }

  const expectedSet = new Set(expected);
  const removedSet = new Set(removed);
  const schedulersByKey = new Map(schedulers.map((scheduler) => [scheduler.key, scheduler]));

  for (const datasetId of expectedSet) {
    // 期望态与删除态冲突时以显式删除态为准。
    if (removedSet.has(datasetId)) continue;
    const existing = schedulersByKey.get(datasetId);
    if (existing) {
      if (!schedulerMatchesDataset(existing, datasetId)) result.skipped_mismatch += 1;
      continue;
    }
    try {
      await deps.queue.upsertJobScheduler(
        datasetId,
        { every: intervalMs },
        { name: DATASET_SYNC_SCHEDULER_JOB_NAME, data: { datasetId } },
      );
      result.created += 1;
    } catch (error) {
      result.error += 1;
      deps.logger?.log('dataset-sync-scheduler.upsert_failed', {
        datasetId,
        error: errorName(error),
      });
    }
  }

  for (const datasetId of removedSet) {
    const existing = schedulersByKey.get(datasetId);
    if (!existing) {
      result.skipped_missing += 1;
      continue;
    }
    if (!schedulerMatchesDataset(existing, datasetId)) {
      result.skipped_mismatch += 1;
      continue;
    }
    try {
      const removedOk = await deps.queue.removeJobScheduler(datasetId);
      if (removedOk) result.dropped += 1;
      else result.skipped_missing += 1;
    } catch (error) {
      result.error += 1;
      deps.logger?.log('dataset-sync-scheduler.remove_failed', {
        datasetId,
        error: errorName(error),
      });
    }
  }

  for (const scheduler of schedulers) {
    if (expectedSet.has(scheduler.key) || removedSet.has(scheduler.key)) continue;
    // 未知调度manual：保留并记录，绝不删除。
    result.skipped_mismatch += 1;
  }

  deps.logger?.log('dataset-sync-scheduler.reconciled', {
    ...result,
    expected: expectedSet.size,
    removed: removedSet.size,
  });
  return result;
}
