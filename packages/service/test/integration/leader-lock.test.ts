import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { reconcileDatasetSyncSchedulers } from '../../src/shared/runtime/dataset-sync-scheduler';
import { createLeaderLock } from '../../src/shared/runtime/leader-lock';

const redis = new Redis(process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `kb:test:leader-lock:${runId}`;
// BullMQ 队列名不允许包含 ":"，仅测试数据键使用带命名空间的 prefix。
const queue = new Queue(`kb-test-leader-lock-${runId}`, { connection: redis });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  const schedulers = await queue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await queue.removeJobScheduler(scheduler.key);
  }
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await redis.quit();
});

describe('leader lock (设计 5.5 / 9.13)', () => {
  it('同一时刻只有一个实例持有锁', async () => {
    const key = `${prefix}:single`;
    const lockA = createLeaderLock({ redis, key, ttlMs: 5_000 });
    const lockB = createLeaderLock({ redis, key, ttlMs: 5_000 });

    expect(await lockA.acquire()).toBe(true);
    expect(await lockB.acquire()).toBe(false);
    expect(lockA.isHeld()).toBe(true);
    expect(lockB.isHeld()).toBe(false);
    expect(await lockA.renew()).toBe(true);

    await lockA.release();
    expect(await lockB.acquire()).toBe(true);
    await lockB.release();
  });

  it('锁过期后可被接管，原持有者 renew 失败', async () => {
    const key = `${prefix}:expire`;
    const lockA = createLeaderLock({ redis, key, ttlMs: 60 });
    expect(await lockA.acquire()).toBe(true);

    await sleep(120);

    const lockB = createLeaderLock({ redis, key, ttlMs: 5_000 });
    expect(await lockB.acquire()).toBe(true);
    expect(await lockA.renew()).toBe(false);
    await lockA.release();
    expect(lockB.isHeld()).toBe(true);
    expect(await lockB.renew()).toBe(true);
    await lockB.release();
  });
});

describe('dataset sync scheduler reconcile (设计 9.13 / 16.4)', () => {
  it('缺失补齐、删除态移除、未知调度保留、幂等且失败下轮重试', async () => {
    const lock = createLeaderLock({ redis, key: `${prefix}:reconcile`, ttlMs: 10_000 });
    const intervalMs = 3_600_000;

    // 预置：删除态 ds-drop、未知调度 ds-unknown、模板不匹配 ds-mismatch。
    await queue.upsertJobScheduler(
      'ds-drop',
      { every: intervalMs },
      { name: 'sync', data: { datasetId: 'ds-drop' } },
    );
    await queue.upsertJobScheduler(
      'ds-unknown',
      { every: intervalMs },
      { name: 'sync', data: { datasetId: 'ds-unknown' } },
    );
    await queue.upsertJobScheduler(
      'ds-mismatch',
      { every: intervalMs },
      { name: 'other', data: { datasetId: 'ds-mismatch' } },
    );

    const first = await reconcileDatasetSyncSchedulers({
      queue,
      lock,
      listExpectedDatasetIds: async () => ['ds-keep-1', 'ds-keep-2', 'ds-mismatch'],
      listRemovedDatasetIds: async () => ['ds-drop'],
      intervalMs,
    });

    expect(lock.isHeld()).toBe(true);
    expect(first.created).toBe(2);
    expect(first.dropped).toBe(1);
    expect(first.skipped_mismatch).toBe(2);
    expect(first.skipped_missing).toBe(0);
    expect(first.error).toBe(0);

    const keysAfterFirst = (await queue.getJobSchedulers())
      .map((scheduler) => scheduler.key)
      .sort();
    expect(keysAfterFirst).toEqual(['ds-keep-1', 'ds-keep-2', 'ds-mismatch', 'ds-unknown']);

    // 幂等：第二轮不再创建；删除态已无对应调度，计入 skipped_missing。
    const second = await reconcileDatasetSyncSchedulers({
      queue,
      lock,
      listExpectedDatasetIds: async () => ['ds-keep-1', 'ds-keep-2', 'ds-mismatch'],
      listRemovedDatasetIds: async () => ['ds-drop'],
      intervalMs,
    });
    expect(second.created).toBe(0);
    expect(second.dropped).toBe(0);
    expect(second.skipped_missing).toBe(1);
    expect(second.skipped_mismatch).toBe(2);
    expect(second.error).toBe(0);

    // 失败下轮重试：注入 upsert 抛错的 queue 包装。
    const failingQueue = {
      getJobSchedulers: () => queue.getJobSchedulers(),
      upsertJobScheduler: async () => {
        throw new RangeError('redis down');
      },
      removeJobScheduler: (id: string) => queue.removeJobScheduler(id),
    } as unknown as Queue;

    const failedRound = await reconcileDatasetSyncSchedulers({
      queue: failingQueue,
      lock,
      listExpectedDatasetIds: async () => ['ds-retry'],
      intervalMs,
    });
    expect(failedRound.created).toBe(0);
    expect(failedRound.error).toBe(1);
    expect((await queue.getJobSchedulers()).some((scheduler) => scheduler.key === 'ds-retry')).toBe(
      false,
    );

    const retryRound = await reconcileDatasetSyncSchedulers({
      queue,
      lock,
      listExpectedDatasetIds: async () => ['ds-retry'],
      intervalMs,
    });
    expect(retryRound.created).toBe(1);
    expect(retryRound.error).toBe(0);
    expect((await queue.getJobSchedulers()).some((scheduler) => scheduler.key === 'ds-retry')).toBe(
      true,
    );

    await lock.release();
  });

  it('未持有锁的实例跳过本轮（下一轮重试）', async () => {
    const key = `${prefix}:skip`;
    const holder = createLeaderLock({ redis, key, ttlMs: 10_000 });
    const other = createLeaderLock({ redis, key, ttlMs: 10_000 });
    expect(await holder.acquire()).toBe(true);

    const result = await reconcileDatasetSyncSchedulers({
      queue,
      lock: other,
      listExpectedDatasetIds: async () => ['ds-never'],
      intervalMs: 3_600_000,
    });
    expect(result).toEqual({
      created: 0,
      dropped: 0,
      skipped_missing: 0,
      skipped_mismatch: 0,
      error: 0,
    });
    expect((await queue.getJobSchedulers()).some((scheduler) => scheduler.key === 'ds-never')).toBe(
      false,
    );

    await holder.release();
  });
});
