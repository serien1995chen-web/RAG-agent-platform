import { HealthProbeService, type AppConfig, type RequestContext } from '@kb/service';
import type { RuntimeClients } from './clients';

export interface AppRuntime {
  config: AppConfig;
  clients: RuntimeClients;
  health: HealthProbeService;
  startedAt: number;
  startup: { state: 'starting' | 'ready' | 'failed'; issues: string[] };
}

export function systemContext(requestId: string): RequestContext {
  return {
    requestId,
    tenant: { teamId: 'system', tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
  };
}

/** 真实依赖探针：Mongo ping、Redis ping、PG SELECT 1、S3 bucket 可用。 */
export function buildHealthService(config: AppConfig, clients: RuntimeClients): HealthProbeService {
  const health = new HealthProbeService(config.system.timeouts.requestMs);

  health.register({
    name: 'mongo',
    required: true,
    check: async () => {
      const startedAt = Date.now();
      await clients.mongo.db!.admin().ping();
      return { name: 'mongo', status: 'ok', durationMs: Date.now() - startedAt };
    },
  });
  health.register({
    name: 'redis',
    required: true,
    check: async () => {
      const startedAt = Date.now();
      await clients.redis.ping();
      return { name: 'redis', status: 'ok', durationMs: Date.now() - startedAt };
    },
  });
  health.register({
    name: 'pgvector',
    required: true,
    check: async () => {
      const startedAt = Date.now();
      await clients.pg.query('SELECT 1');
      return { name: 'pgvector', status: 'ok', durationMs: Date.now() - startedAt };
    },
  });
  health.register({
    name: 'object-store',
    required: true,
    check: async () => {
      const startedAt = Date.now();
      await clients.objectStore.ensureBucket();
      return { name: 'object-store', status: 'ok', durationMs: Date.now() - startedAt };
    },
  });

  return health;
}

let runtimePromise: Promise<AppRuntime> | undefined;

async function bootstrap(): Promise<AppRuntime> {
  const { getAppConfig } = await import('./config');
  const { createRuntimeClients } = await import('./clients');
  const config = getAppConfig();
  const clients = await createRuntimeClients(config);
  const health = buildHealthService(config, clients);
  const runtime: AppRuntime = {
    config,
    clients,
    health,
    startedAt: Date.now(),
    startup: { state: 'starting', issues: [] },
  };
  try {
    const required = await health.checkRequired(systemContext('startupz'));
    const summary = health.summarize(required, []);
    runtime.startup.state = summary.httpStatus === 200 ? 'ready' : 'failed';
    runtime.startup.issues = required
      .filter((check) => check.status === 'failed')
      .map((check) => check.name);
  } catch {
    runtime.startup.state = 'failed';
    runtime.startup.issues = ['bootstrap'];
  }
  return runtime;
}

export function getRuntime(): Promise<AppRuntime> {
  runtimePromise ??= bootstrap();
  return runtimePromise;
}
