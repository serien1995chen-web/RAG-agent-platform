import type { WorkerMode } from './system-config.schema';
import { ConfigValidationException } from './config-error';

export interface RuntimeRole {
  mode: WorkerMode;
  runsHttp: boolean;
  runsWorker: boolean;
  runsChangeStream: boolean;
  runsScheduler: boolean;
}

/**
 * 设计文档 5.4 / 6.4 / ADR-014：
 * - http：只服务 HTTP，主副本监听 Change Stream；
 * - worker：只领取任务并运行 Scheduler/Cron；
 * - all：同进程承担两者（Compose 首期形态）。
 * 首期不提供独立 Worker 容器入口，角色由同一镜像的配置切换。
 */
export function resolveRuntimeRole(mode: WorkerMode): RuntimeRole {
  switch (mode) {
    case 'http':
      return {
        mode,
        runsHttp: true,
        runsWorker: false,
        runsChangeStream: true,
        runsScheduler: false,
      };
    case 'worker':
      return {
        mode,
        runsHttp: false,
        runsWorker: true,
        runsChangeStream: false,
        runsScheduler: true,
      };
    case 'all':
      return {
        mode,
        runsHttp: true,
        runsWorker: true,
        runsChangeStream: true,
        runsScheduler: true,
      };
    default:
      throw new ConfigValidationException([`APP_WORKER_MODE 非法: ${String(mode)}`]);
  }
}
