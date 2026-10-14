import { pathToFileURL } from 'node:url';
import {
  resolveRuntimeRole,
  type AppConfig,
  type RequestContext,
  type RuntimeRole,
  type ServicePorts,
} from '@kb/service';
// Plan D4 冻结 @kb/service barrel；leader-lock 按相对路径引用包内实现（P3 深导入先例）。
import { createLeaderLock } from '../../../../packages/service/src/shared/runtime/leader-lock';
import { createCompensationSweeperUnit } from '../../../../packages/service/src/shared/runtime/compensation-sweeper';
import { createS3TtlSweeperUnit } from '../../../../packages/service/src/shared/runtime/ttl-sweeper';
import {
  bootstrapRuntime,
  type ExtendedAppRuntime,
  type RuntimeBootstrapOptions,
} from './bootstrap';
import { getAppConfig } from './config';
import { createDrainCoordinator, type DrainCoordinator, type RuntimeUnit } from './drain';
import { createRuntimeWorkerUnits } from './queue-workers';
import { createDatasetSyncScheduler } from './scheduler';

export interface WorkerRuntimeOptions {
  config?: AppConfig;
  deadlineMs?: number;
  /** 仅进程入口安装信号处理；测试与宿主装配可显式关闭。 */
  installSignalHandlers?: boolean;
  exit?: (code: number) => void;
  bootstrapRuntime?: (options?: RuntimeBootstrapOptions) => Promise<ExtendedAppRuntime>;
  createUnits?: (runtime: ExtendedAppRuntime, role: RuntimeRole) => RuntimeUnit[];
  /** E-1 方案 C：期望态由注入提供者给出，本阶段不做跨租户扫描。 */
  listExpectedDatasetIds?: () => Promise<readonly string[]>;
  ports?: ServicePorts;
}

export interface WorkerRuntimeHandle {
  role: RuntimeRole;
  drain: DrainCoordinator;
  runtime?: ExtendedAppRuntime;
}

const emptyExpectedDatasetIds = async (): Promise<readonly string[]> => [];

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const RECONCILE_LOCK_TTL_MS = 600_000;
const RECONCILE_LOCK_KEY = 'runtime:delete-reconcile';

function reconcileContext(): RequestContext {
  return {
    requestId: `delete-reconcile-${Date.now()}`,
    tenant: { teamId: 'system', tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
  };
}

/**
 * 对账单元（P6-03）：启动即跑 + 每 60 分钟一轮；锁丢失时不执行下一轮并记日志；
 * close 等待在途并释放 leader lock（drain 顺序 claims→leases→leader-lock 不变）。
 */
function createReconcileSweeperUnit(runtime: ExtendedAppRuntime): RuntimeUnit {
  const lock = createLeaderLock({
    redis: runtime.clients.redis,
    key: RECONCILE_LOCK_KEY,
    ttlMs: RECONCILE_LOCK_TTL_MS,
  });
  const logger = runtime.clients.logger;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;

  const renewTimer = setInterval(
    () => {
      if (closed || !lock.isHeld()) return;
      void lock
        .renew()
        .then((renewed) => {
          if (!renewed) logger.log('delete-reconcile.lock_lost', {});
        })
        .catch((error: unknown) => {
          logger.log('delete-reconcile.renew_failed', {
            error: error instanceof Error ? error.name : typeof error,
          });
        });
    },
    Math.max(1, Math.floor(RECONCILE_LOCK_TTL_MS / 3)),
  );

  const round = async (): Promise<void> => {
    if (closed) return;
    try {
      const held = lock.isHeld() || (await lock.acquire());
      if (!held) {
        logger.log('delete-reconcile.round_skipped', { reason: 'lock_not_held' });
      } else {
        const summaries = await runtime.reconcileService.run(
          { mode: 'apply', scope: { kind: 'global' } },
          reconcileContext(),
        );
        logger.log('delete-reconcile.round', { reports: summaries.length });
      }
    } catch (error) {
      logger.log('delete-reconcile.round_failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    if (!closed) {
      timer = setTimeout(runRound, RECONCILE_INTERVAL_MS);
    }
  };

  const runRound = (): void => {
    inFlight = round().finally(() => {
      inFlight = undefined;
    });
    void inFlight;
  };

  runRound();

  return {
    name: 'delete-reconcile',
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

function defaultUnits(
  runtime: ExtendedAppRuntime,
  role: RuntimeRole,
  options: WorkerRuntimeOptions,
): RuntimeUnit[] {
  const units: RuntimeUnit[] = [];
  // 关闭顺序由 phase 排序保证：先停止领取（queue workers），再释放 leader lock（scheduler）。
  if (role.runsWorker) {
    units.push(...createRuntimeWorkerUnits(runtime));
  }
  if (role.runsScheduler) {
    units.push(
      createDatasetSyncScheduler(runtime, {
        listExpectedDatasetIds: options.listExpectedDatasetIds ?? emptyExpectedDatasetIds,
      }),
      createReconcileSweeperUnit(runtime),
      createS3TtlSweeperUnit({
        service: runtime.s3TtlService,
        redis: runtime.clients.redis,
        logger: runtime.clients.logger,
      }),
      createCompensationSweeperUnit({
        service: runtime.compensationService,
        redis: runtime.clients.redis,
        logger: runtime.clients.logger,
      }),
    );
  }
  return units;
}

interface ShutdownSignalDeps {
  drain: DrainCoordinator;
  runtime: ExtendedAppRuntime;
  exit: (code: number) => void;
}

function installShutdownSignals(deps: ShutdownSignalDeps): void {
  const handle = (signal: NodeJS.Signals): void => {
    void (async () => {
      deps.runtime.clients.logger.log('worker.shutdown.signal', { signal });
      const result = await deps.drain.beginShutdown(signal);
      deps.runtime.clients.logger.log('worker.shutdown.drained', {
        signal,
        timedOut: result.timedOut,
        remainingUnits: result.remainingUnits,
      });
      try {
        await deps.runtime.shutdown();
      } catch {
        // 连接释放失败不改变退出码语义；仅 drain deadline 超时以非 0 退出。
      }
      deps.exit(result.timedOut ? 1 : 0);
    })();
  };
  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
}

/**
 * Worker 进程入口（设计文档 5.4 / 5.5）：同一镜像按 APP_WORKER_MODE 切换角色。
 * http 角色不启动领取单元、不装配 worker 运行时；worker/all 角色装配并启动队列与调度单元。
 */
export async function startWorkerRuntime(
  options: WorkerRuntimeOptions = {},
): Promise<WorkerRuntimeHandle> {
  const config = options.config ?? getAppConfig();
  const role = resolveRuntimeRole(config.system.appWorkerMode);
  const drain = createDrainCoordinator({ deadlineMs: options.deadlineMs });

  if (!role.runsWorker) {
    drain.markReady();
    return { role, drain };
  }

  const bootstrap = options.bootstrapRuntime ?? bootstrapRuntime;
  const runtime = await bootstrap({
    drain: async () => {
      await drain.beginShutdown('shutdown');
    },
    ...(options.ports !== undefined ? { ports: options.ports } : {}),
  });

  const units = (options.createUnits ?? defaultUnits)(runtime, role, options);
  for (const unit of units) drain.register(unit);

  if (options.installSignalHandlers ?? true) {
    installShutdownSignals({
      drain,
      runtime,
      exit: options.exit ?? ((code) => process.exit(code)),
    });
  }
  drain.markReady();
  return { role, drain, runtime };
}

async function main(): Promise<void> {
  await startWorkerRuntime();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`worker 启动失败: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
