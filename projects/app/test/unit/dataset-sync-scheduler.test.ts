import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedAppRuntime } from '../../src/runtime/bootstrap';

const mocks = vi.hoisted(() => {
  const queueClose = vi.fn(async () => undefined);
  const lock = {
    acquire: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    isHeld: vi.fn(() => true),
  };
  const reconcile = vi.fn(async () => ({
    created: 0,
    dropped: 0,
    skipped_missing: 0,
    skipped_mismatch: 0,
    error: 0,
  }));
  const logger = { log: vi.fn(), child: vi.fn() };
  return { queueClose, lock, reconcile, logger };
});

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    async close(): Promise<void> {
      return mocks.queueClose();
    }
  },
}));

vi.mock('../../../../packages/service/src/shared/runtime/leader-lock', () => ({
  createLeaderLock: () => mocks.lock,
}));

vi.mock('../../../../packages/service/src/shared/runtime/dataset-sync-scheduler', () => ({
  reconcileDatasetSyncSchedulers: mocks.reconcile,
}));

import { createDatasetSyncScheduler } from '../../src/runtime/scheduler';

function fakeRuntime(): ExtendedAppRuntime {
  return {
    clients: { redis: {}, logger: mocks.logger },
  } as unknown as ExtendedAppRuntime;
}

describe('dataset-sync-scheduler 关闭与续租（PR #7 Review 问题 3/4 修复）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.lock.acquire.mockResolvedValue(true);
    mocks.lock.isHeld.mockReturnValue(true);
    mocks.lock.renew.mockResolvedValue(true);
    mocks.lock.release.mockResolvedValue(undefined);
    mocks.queueClose.mockResolvedValue(undefined);
    mocks.reconcile.mockResolvedValue({
      created: 0,
      dropped: 0,
      skipped_missing: 0,
      skipped_mismatch: 0,
      error: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('close 等待在途 reconcile 完成后，先释放 leader lock 再关闭 Queue', async () => {
    let resolveRound: (() => void) | undefined;
    mocks.reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRound = () =>
            resolve({ created: 0, dropped: 0, skipped_missing: 0, skipped_mismatch: 0, error: 0 });
        }),
    );
    const unit = createDatasetSyncScheduler(fakeRuntime(), {
      listExpectedDatasetIds: async () => [],
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);

    const closePromise = unit.close();
    await Promise.resolve();
    expect(mocks.lock.release).not.toHaveBeenCalled();
    expect(mocks.queueClose).not.toHaveBeenCalled();

    resolveRound?.();
    await closePromise;

    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queueClose.mock.invocationCallOrder[0],
    );
  });

  it('renew rejection 被捕获并记录，不形成未处理拒绝', async () => {
    mocks.lock.renew.mockRejectedValueOnce(new RangeError('redis down'));
    const unit = createDatasetSyncScheduler(fakeRuntime(), {
      listExpectedDatasetIds: async () => [],
      lockTtlMs: 900,
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.lock.renew).toHaveBeenCalled();
    expect(mocks.logger.log).toHaveBeenCalledWith(
      'dataset-sync-scheduler.renew_failed',
      expect.objectContaining({ error: 'RangeError' }),
    );

    await unit.close();
  });
});
