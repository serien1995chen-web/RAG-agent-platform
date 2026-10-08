import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@kb/dal';
// Plan D4 冻结 @kb/service barrel（不在 25 条文件清单内），scheduler 单元按相对路径引用包内实现。
import {
  createLeaderLock,
  type LeaderLock,
} from '../../../../packages/service/src/shared/runtime/leader-lock';
import { reconcileDatasetSyncSchedulers } from '../../../../packages/service/src/shared/runtime/dataset-sync-scheduler';
import type { ExtendedAppRuntime } from './bootstrap';
import type { RuntimeUnit } from './drain';

/** reconcile 周期：启动一次 + 每小时一次（设计文档 9.13）。 */
export const DEFAULT_SCHEDULER_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
/** leader lock TTL 与续租间隔（TTL/3）可配置，默认 30s（设计文档 5.5 租约语义）。 */
export const DEFAULT_SCHEDULER_LOCK_TTL_MS = 30_000;
export const DEFAULT_SCHEDULER_LOCK_KEY = 'kb:leader:dataset-sync-scheduler';

export interface DatasetSyncSchedulerUnitOptions {
  /** E-1 方案 C：期望态由注入提供者给出，本阶段不做跨租户扫描。 */
  listExpectedDatasetIds: () => Promise<readonly string[]>;
  listRemovedDatasetIds?: () => Promise<readonly string[]>;
  intervalMs?: number;
  /** BullMQ 调度周期（默认 24 小时，设计文档 16.4），测试可注入。 */
  syncIntervalMs?: number;
  lockTtlMs?: number;
  lockKey?: string;
}

export function createDatasetSyncScheduler(
  runtime: ExtendedAppRuntime,
  options: DatasetSyncSchedulerUnitOptions,
): RuntimeUnit {
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_SCHEDULER_LOCK_TTL_MS;
  const reconcileIntervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_RECONCILE_INTERVAL_MS;
  const lock: LeaderLock = createLeaderLock({
    redis: runtime.clients.redis,
    key: options.lockKey ?? DEFAULT_SCHEDULER_LOCK_KEY,
    ttlMs: lockTtlMs,
  });
  const queue = new Queue(QUEUE_NAMES.sync, { connection: runtime.clients.redis });
  const logger = runtime.clients.logger;

  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const reconcile = async (): Promise<void> => {
    if (closed) return;
    try {
      const result = await reconcileDatasetSyncSchedulers({
        queue,
        lock,
        listExpectedDatasetIds: options.listExpectedDatasetIds,
        ...(options.listRemovedDatasetIds !== undefined
          ? { listRemovedDatasetIds: options.listRemovedDatasetIds }
          : {}),
        ...(options.syncIntervalMs !== undefined ? { intervalMs: options.syncIntervalMs } : {}),
        logger,
      });
      logger.log('dataset-sync-scheduler.round', { ...result });
    } catch (error) {
      // reconcile 内部按条记录失败；此处只防御未预期异常，下一轮重试。
      logger.log('dataset-sync-scheduler.round_failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    if (!closed) {
      reconcileTimer = setTimeout(() => void reconcile(), reconcileIntervalMs);
    }
  };

  const renewTimer = setInterval(
    () => {
      if (closed || !lock.isHeld()) return;
      void lock.renew().then((renewed) => {
        if (!renewed) logger.log('dataset-sync-scheduler.lock_lost', {});
      });
    },
    Math.max(1, Math.floor(lockTtlMs / 3)),
  );

  void reconcile();

  return {
    name: 'dataset-sync-scheduler',
    phase: 'leader-lock',
    async close(): Promise<void> {
      closed = true;
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
      clearInterval(renewTimer);
      await lock.release();
      await queue.close();
    },
  };
}
