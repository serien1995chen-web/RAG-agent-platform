import { pathToFileURL } from 'node:url';
import {
  resolveRuntimeRole,
  type AppConfig,
  type RuntimeRole,
  type ServicePorts,
} from '@kb/service';
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
