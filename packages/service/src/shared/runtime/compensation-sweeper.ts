import type Redis from 'ioredis';
import type { CompensationSweepStats } from '../../modules/delete/application/compensation.service';
import type { RequestContext } from '../../ports/types';
import { createLeaderLock } from './leader-lock';

export const COMPENSATION_LOCK_KEY = 'runtime:cross-store-compensation';
export const COMPENSATION_LOCK_TTL_MS = 300_000;
export const COMPENSATION_INTERVAL_MS = 300_000;

export interface CompensationSweeperService {
  sweepOnce(context: RequestContext): Promise<CompensationSweepStats>;
}

export interface CompensationSweeperLogger {
  log(event: string, fields: Record<string, unknown>): void;
}

export interface CompensationSweeperDeps {
  service: CompensationSweeperService;
  redis: Redis;
  logger: CompensationSweeperLogger;
  clock?: () => Date;
  intervalMs?: number;
  lockTtlMs?: number;
}

export interface CompensationSweeperUnit {
  name: 'compensation-sweeper';
  phase: 'leader-lock';
  close(): Promise<void>;
}

function sweeperContext(): RequestContext {
  return {
    requestId: `compensation-sweep-${Date.now()}`,
    tenant: { teamId: 'system', tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
  };
}

/**
 * 补偿 Sweeper 单元（设计 14.9 / AB §4.4）：leader lock `runtime:cross-store-compensation`；
 * 启动即跑 + 每 5 分钟一轮；close 等停并释放锁；与 TTL Sweeper 相同锁语义。
 */
export function createCompensationSweeperUnit(
  deps: CompensationSweeperDeps,
): CompensationSweeperUnit {
  const lockTtlMs = deps.lockTtlMs ?? COMPENSATION_LOCK_TTL_MS;
  const intervalMs = deps.intervalMs ?? COMPENSATION_INTERVAL_MS;
  const lock = createLeaderLock({
    redis: deps.redis,
    key: COMPENSATION_LOCK_KEY,
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
          if (!renewed) deps.logger.log('compensation-sweeper.lock_lost', {});
        })
        .catch((error: unknown) => {
          deps.logger.log('compensation-sweeper.renew_failed', {
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
        deps.logger.log('compensation-sweeper.round_skipped', { reason: 'lock_not_held' });
      } else {
        const stats = await deps.service.sweepOnce(sweeperContext());
        deps.logger.log('compensation-sweeper.round', { ...stats });
      }
    } catch (error) {
      deps.logger.log('compensation-sweeper.round_failed', {
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
    name: 'compensation-sweeper',
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
