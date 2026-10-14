import type Redis from 'ioredis';
import type { S3TtlSweepStats } from '../../modules/delete/application/s3-ttl.service';
import type { RequestContext } from '../../ports/types';
import { createLeaderLock } from './leader-lock';

export const S3_TTL_LOCK_KEY = 'runtime:s3-ttl-sweep';
/** 设计 10.9.1：59 分钟分布式锁 + 小时级轮次。 */
export const S3_TTL_LOCK_TTL_MS = 59 * 60 * 1000;
export const S3_TTL_INTERVAL_MS = 60 * 60 * 1000;

export interface S3TtlSweeperService {
  sweepOnce(context: RequestContext): Promise<S3TtlSweepStats>;
}

export interface S3TtlSweeperLogger {
  log(event: string, fields: Record<string, unknown>): void;
}

export interface S3TtlSweeperDeps {
  service: S3TtlSweeperService;
  redis: Redis;
  logger: S3TtlSweeperLogger;
  clock?: () => Date;
  intervalMs?: number;
  lockTtlMs?: number;
}

export interface S3TtlSweeperUnit {
  name: 's3-ttl-sweeper';
  phase: 'leader-lock';
  close(): Promise<void>;
}

function sweeperContext(): RequestContext {
  return {
    requestId: `s3-ttl-sweep-${Date.now()}`,
    tenant: { teamId: 'system', tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
  };
}

/**
 * TTL Sweeper 单元（设计 10.9.1 / 5.5）：59 分钟 leader lock；
 * 启动即跑一轮 + 每 60 分钟一轮（完成后 setTimeout 排下一轮）；
 * close 清定时器、等待在途、释放锁；未持锁不执行、单进程内不重入。
 */
export function createS3TtlSweeperUnit(deps: S3TtlSweeperDeps): S3TtlSweeperUnit {
  const lockTtlMs = deps.lockTtlMs ?? S3_TTL_LOCK_TTL_MS;
  const intervalMs = deps.intervalMs ?? S3_TTL_INTERVAL_MS;
  const lock = createLeaderLock({
    redis: deps.redis,
    key: S3_TTL_LOCK_KEY,
    ttlMs: lockTtlMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;

  const renewTimer = setInterval(
    () => {
      if (closed || !lock.isHeld()) return;
      void lock
        .renew()
        .then((renewed) => {
          if (!renewed) deps.logger.log('s3-ttl-sweeper.lock_lost', {});
        })
        .catch((error: unknown) => {
          deps.logger.log('s3-ttl-sweeper.renew_failed', {
            error: error instanceof Error ? error.name : typeof error,
          });
        });
    },
    Math.max(1, Math.floor(lockTtlMs / 3)),
  );

  const round = async (): Promise<void> => {
    if (closed) return;
    try {
      const held = lock.isHeld() || (await lock.acquire());
      if (!held) {
        deps.logger.log('s3-ttl-sweeper.round_skipped', { reason: 'lock_not_held' });
      } else {
        const stats = await deps.service.sweepOnce(sweeperContext());
        deps.logger.log('s3-ttl-sweeper.round', { ...stats });
      }
    } catch (error) {
      deps.logger.log('s3-ttl-sweeper.round_failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    if (!closed) timer = setTimeout(runRound, intervalMs);
  };

  const runRound = (): void => {
    inFlight = round().finally(() => {
      inFlight = undefined;
    });
    void inFlight;
  };

  runRound();

  return {
    name: 's3-ttl-sweeper',
    phase: 'leader-lock',
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(renewTimer);
      const pending = inFlight;
      if (pending) await pending.catch(() => undefined);
      await lock.release();
    },
  };
}
