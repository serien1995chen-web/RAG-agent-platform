import type { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import type { KnowledgeRuntimeConfig } from '../../../shared/config/knowledge-runtime-config';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import { safeAuditDiff } from '../../../shared/persistence/knowledge/audit';
import type { S10StatusProbePort, S10StatusView } from '../application/s10-status.application';
import type { ModelCatalogItem, ModelCatalogPort } from '../application/s5-model-ports';

export const CONNECTOR_STALE_GRACE_MS = 5 * 60_000;

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
      modelHealth?: {
        probe(
          context: TenantContext,
          models: readonly ModelCatalogItem[],
        ): Promise<{ verifiedTypes: string[] }>;
      };
      connectors?: {
        list(context: TenantContext): Promise<S10StatusView['connectorProbes']>;
      };
      securityProbe?: () => Promise<{
        scopeEnforced: boolean;
        auditAppendOnly: boolean;
        secretRedactionEnabled: boolean;
      }>;
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

  private classifyModelFailure(error: unknown): { reason: string; errorCode: string } {
    const record =
      error !== null && typeof error === 'object'
        ? (error as {
            kind?: unknown;
            status?: unknown;
            message?: unknown;
            problem?: { error?: { details?: { reason?: unknown } } };
          })
        : {};
    const status = Number(record.status);
    const kind = typeof record.kind === 'string' ? record.kind : '';
    const message =
      `${String(record.message ?? '')} ${String(record.problem?.error?.details?.reason ?? '')}`.toLowerCase();
    let reason = 'probe_failed';
    if (status === 401 || kind === 'auth' || /unauthori[sz]ed/.test(message)) {
      reason = 'unauthorized';
    } else if (status === 403 || /forbidden/.test(message)) {
      reason = 'forbidden';
    } else if (status === 404 || /not[_ -]?found/.test(message)) {
      reason = 'not_found';
    } else if (status === 429 || kind === 'rate_limit' || /rate[_ -]?limit/.test(message)) {
      reason = 'rate_limited';
    } else if (status >= 500 || /server|provider[_ -]?failed/.test(message)) {
      reason = 'server_error';
    } else if (/timeout|timed out/.test(message) || kind === 'timeout') {
      reason = 'timeout';
    } else if (
      kind === 'contract' ||
      kind === 'validation' ||
      /invalid|contract|schema/.test(message)
    ) {
      reason = 'invalid_response';
    }
    return { reason, errorCode: `MODEL_PROBE_${reason.toUpperCase()}` };
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
      if (!fixture) {
        if (!this.input.modelHealth) {
          return {
            status: 'external_unverified',
            verificationStatus: 'EXTERNAL_UNVERIFIED' as const,
            latencyMs: Date.now() - startedAt,
            modelCount: models.length,
          };
        }
        await Promise.race([
          this.input.modelHealth.probe(context, models),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('model_probe_timeout')), 60_000);
            timer.unref?.();
          }),
        ]);
      }
      return {
        status: fixture ? 'fixture_verified' : 'ok',
        verificationStatus: fixture ? ('FIXTURE_VERIFIED' as const) : ('REAL_VERIFIED' as const),
        latencyMs: Date.now() - startedAt,
        modelCount: models.length,
      };
    } catch (error) {
      const failure = this.classifyModelFailure(error);
      return {
        status: 'unavailable',
        verificationStatus: 'UNKNOWN' as const,
        latencyMs: Date.now() - startedAt,
        ...failure,
      };
    }
  }

  private async connectorProbes(context: TenantContext) {
    const now = this.input.now?.() ?? new Date();
    if (this.input.connectors) {
      return (await this.input.connectors.list(context)).map((connector) =>
        this.connectorView(connector, now),
      );
    }
    const models = registerKnowledgeModels(this.input.connection);
    const connectors = await models.KnowledgeConnector.find({
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
    })
      .select({
        _id: 1,
        provider: 1,
        status: 1,
        syncEnabled: 1,
        lastAttemptAt: 1,
        lastSuccessAt: 1,
        nextSyncAt: 1,
        lastError: 1,
      })
      .limit(100)
      .lean();
    return connectors.map((connector) =>
      this.connectorView(
        {
          connectorId: String(connector._id),
          provider: connector.provider,
          status: connector.status,
          verificationStatus: 'EXTERNAL_UNVERIFIED' as const,
          lastAttemptAt: connector.lastAttemptAt?.toISOString() ?? null,
          lastSuccessAt: connector.lastSuccessAt?.toISOString() ?? null,
          nextSyncAt: connector.nextSyncAt?.toISOString() ?? null,
          lastError: connector.lastError,
        },
        now,
      ),
    );
  }

  private safeLastError(value: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!value) return null;
    const redacted = safeAuditDiff(value);
    if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) return null;
    const record = redacted as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of ['code', 'message', 'messageKey', 'retryable', 'retryAfter', 'provider']) {
      const entry = record[key];
      if (typeof entry === 'string' && entry.length > 0) safe[key] = entry.slice(0, 512);
      else if (typeof entry === 'boolean' || typeof entry === 'number') safe[key] = entry;
    }
    return Object.keys(safe).length > 0 ? safe : null;
  }

  private connectorView(
    connector: S10StatusView['connectorProbes'][number],
    now: Date,
  ): S10StatusView['connectorProbes'][number] {
    const nextSyncAt = connector.nextSyncAt ?? null;
    const stale =
      connector.status === 'active' &&
      nextSyncAt !== null &&
      Date.parse(nextSyncAt) + CONNECTOR_STALE_GRACE_MS < now.getTime();
    return {
      ...connector,
      lastAttemptAt: connector.lastAttemptAt ?? null,
      lastSuccessAt: connector.lastSuccessAt ?? null,
      nextSyncAt,
      lastError: this.safeLastError(connector.lastError ?? null),
      stale,
    };
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

  private async securityEvidence() {
    if (!this.input.securityProbe) {
      return {
        scopeEnforced: false,
        auditAppendOnly: false,
        secretRedactionEnabled: false,
      };
    }
    try {
      const evidence = await this.input.securityProbe();
      return {
        scopeEnforced: evidence.scopeEnforced === true,
        auditAppendOnly: evidence.auditAppendOnly === true,
        secretRedactionEnabled: evidence.secretRedactionEnabled === true,
      };
    } catch {
      return {
        scopeEnforced: false,
        auditAppendOnly: false,
        secretRedactionEnabled: false,
      };
    }
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
    const [
      dependencies,
      queueResult,
      modelProbe,
      connectorResult,
      reconciliation,
      securityEvidence,
    ] = await Promise.all([
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
      this.securityEvidence(),
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
        scopeEnforced: securityEvidence.scopeEnforced,
        auditAppendOnly: securityEvidence.auditAppendOnly,
        secretRedactionEnabled: securityEvidence.secretRedactionEnabled,
        rateLimitEnabled: this.input.config.s10.quota.requestsPerMinute > 0,
      },
      reconciliation,
    };
  }
}
