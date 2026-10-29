import type { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import type { KnowledgeRuntimeConfig } from '../../../shared/config/knowledge-runtime-config';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { S10StatusProbePort, S10StatusView } from '../application/s10-status.application';
import type { ModelCatalogPort } from '../application/s5-model-ports';

function state(
  status: S10StatusView['dependencies']['mongo']['status'],
  latencyMs: number,
  verificationStatus: S10StatusView['dependencies']['mongo']['verificationStatus'],
  reason?: string,
): S10StatusView['dependencies']['mongo'] {
  return {
    status,
    latencyMs,
    verificationStatus,
    ...(reason ? { reason } : {}),
  };
}

export class S10StatusProbesAdapter implements S10StatusProbePort {
  constructor(
    private readonly input: {
      config: KnowledgeRuntimeConfig;
      connection: Connection;
      queues: ReadonlyMap<string, Queue>;
      readiness: (requestId: string) => Promise<{
        status: number;
        body: { checks: Array<{ name: string; status: string; latencyMs: number }> };
      }>;
      models: ModelCatalogPort;
      connectors?: {
        list(context: TenantContext): Promise<S10StatusView['connectorProbes']>;
      };
      now?: () => Date;
    },
  ) {}

  private async dependencyProbes(context: TenantContext) {
    const health = await this.input.readiness(context.requestId);
    const byName = new Map(health.body.checks.map((check) => [check.name, check]));
    const resolve = (name: 'mongo' | 'redis' | 'postgres' | 's3') => {
      const check = byName.get(name);
      if (!check) return state('down', 0, 'UNKNOWN', 'probe_missing');
      if (check.status === 'ok') return state('ok', check.latencyMs, 'REAL_VERIFIED');
      if (check.status === 'down') return state('down', check.latencyMs, 'REAL_VERIFIED');
      return state('degraded', check.latencyMs, 'UNKNOWN', `probe_${check.status}`);
    };
    return {
      mongo: resolve('mongo'),
      redis: resolve('redis'),
      postgres: resolve('postgres'),
      s3: resolve('s3'),
    };
  }

  private async queueLag() {
    const result: S10StatusView['queueLag'] = {};
    for (const [name, queue] of this.input.queues) {
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'failed');
      const waiting = Number(counts.waiting ?? 0);
      const delayed = Number(counts.delayed ?? 0);
      result[name] = {
        waiting,
        delayed,
        active: Number(counts.active ?? 0),
        failed: Number(counts.failed ?? 0),
        lag: waiting + delayed,
      };
    }
    return result;
  }

  private async modelProbe(context: TenantContext) {
    const startedAt = Date.now();
    const fixture = this.input.config.externalModes.model !== 'real';
    try {
      const models = await this.input.models.listModels({
        workspaceId: context.workspaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      });
      return {
        status: fixture ? 'fixture_verified' : 'ok',
        verificationStatus: fixture ? ('FIXTURE_VERIFIED' as const) : ('REAL_VERIFIED' as const),
        latencyMs: Date.now() - startedAt,
        modelCount: models.length,
      };
    } catch {
      return {
        status: 'unavailable',
        verificationStatus: 'UNKNOWN' as const,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private async connectorProbes(context: TenantContext) {
    if (this.input.connectors) return this.input.connectors.list(context);
    const models = registerKnowledgeModels(this.input.connection);
    const connectors = await models.KnowledgeConnector.find({
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
    })
      .select({ _id: 1, provider: 1, status: 1, lastAttemptAt: 1 })
      .limit(100)
      .lean();
    return connectors.map((connector) => ({
      connectorId: String(connector._id),
      provider: connector.provider,
      status: connector.status,
      verificationStatus: 'EXTERNAL_UNVERIFIED' as const,
      lastAttemptAt: connector.lastAttemptAt?.toISOString() ?? null,
    }));
  }

  private async reconciliation(context: TenantContext) {
    const models = registerKnowledgeModels(this.input.connection);
    const job = await models.KnowledgeJob.findOne({
      workspaceId: requireWorkspaceId(context),
      kind: 'reconcile',
      status: 'succeeded',
      deletedAt: null,
    })
      .sort({ updatedAt: -1 })
      .lean();
    if (!job) {
      return {
        lastRunAt: null,
        state: 'unknown' as const,
        orphanObjects: 0,
        orphanVectors: 0,
        diffCount: 0,
        repairedCount: 0,
      };
    }
    const result = (job.result ?? {}) as Record<string, unknown>;
    const items = Array.isArray(result.items)
      ? result.items.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        )
      : [];
    const itemNumber = (scope: string, key: string) => {
      const value = items.find((item) => item.scope === scope)?.[key];
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    };
    return {
      lastRunAt: job.updatedAt.toISOString(),
      state: 'ok' as const,
      orphanObjects: itemNumber('objects', 'missing'),
      orphanVectors: itemNumber('vectors', 'orphan'),
      diffCount: Number(result.diffCount ?? 0),
      repairedCount: Number(result.repairedCount ?? 0),
    };
  }

  async probe(context: TenantContext): Promise<S10StatusView> {
    const startedQueueProbe = Date.now();
    const queueProbePromise = this.queueLag()
      .then((value) => ({
        value,
        probe: state('ok', Date.now() - startedQueueProbe, 'REAL_VERIFIED'),
      }))
      .catch(() => ({
        value: {} as S10StatusView['queueLag'],
        probe: state('degraded', Date.now() - startedQueueProbe, 'UNKNOWN', 'queue_probe_failed'),
      }));
    const startedConnectorProbe = Date.now();
    const connectorProbePromise = this.connectorProbes(context)
      .then((value) => ({
        value,
        probe: state('ok', Date.now() - startedConnectorProbe, 'REAL_VERIFIED'),
      }))
      .catch(() => ({
        value: [] as S10StatusView['connectorProbes'],
        probe: state(
          'degraded',
          Date.now() - startedConnectorProbe,
          'UNKNOWN',
          'connector_probe_failed',
        ),
      }));
    const [dependencies, queueResult, modelProbe, connectorResult, reconciliation] =
      await Promise.all([
        this.dependencyProbes(context),
        queueProbePromise,
        this.modelProbe(context),
        connectorProbePromise,
        this.reconciliation(context).catch(() => ({
          lastRunAt: null,
          state: 'unknown' as const,
          orphanObjects: 0,
          orphanVectors: 0,
          diffCount: 0,
          repairedCount: 0,
        })),
      ]);
    return {
      status: 'degraded',
      queueDepth: {},
      queueLag: queueResult.value,
      storage: {
        provider: this.input.config.s3.provider,
        healthy: dependencies.s3.status === 'ok',
        verificationStatus: dependencies.s3.verificationStatus,
      },
      vector: {
        backend: 'pgvector',
        healthy: dependencies.postgres.status === 'ok',
        profiles: [768, 1024, 1536, 3072],
        verificationStatus: dependencies.postgres.verificationStatus,
      },
      dependencies,
      modelProbe,
      connectorProbes: connectorResult.value,
      queueProbe: queueResult.probe,
      connectorProbe: connectorResult.probe,
      securityChecks: {
        apiKeyHmacConfigured: this.input.config.s10.apiKeyHmacConfigured,
        scopeEnforced: true,
        auditAppendOnly: true,
        secretRedactionEnabled: true,
        rateLimitEnabled: this.input.config.s10.quota.requestsPerMinute > 0,
      },
      reconciliation,
    };
  }
}
