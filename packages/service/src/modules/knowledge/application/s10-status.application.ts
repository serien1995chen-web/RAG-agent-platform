import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { isWorkspaceWideApiKey } from '../domain/s10-api-key';

export type S10VerificationStatus =
  | 'REAL_VERIFIED'
  | 'FIXTURE_VERIFIED'
  | 'EXTERNAL_UNVERIFIED'
  | 'UNKNOWN';

export interface S10ProbeState {
  status: 'ok' | 'degraded' | 'down' | 'timeout';
  latencyMs: number;
  verificationStatus: S10VerificationStatus;
  reason?: string;
}

export interface S10StatusView {
  status: 'ok' | 'degraded';
  queueDepth: Record<string, number>;
  queueLag: Record<
    string,
    { waiting: number; delayed: number; active: number; failed: number; lag: number }
  >;
  storage: {
    provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
    healthy: boolean;
    verificationStatus: S10VerificationStatus;
  };
  vector: {
    backend: 'pgvector';
    healthy: boolean;
    profiles: number[];
    verificationStatus: S10VerificationStatus;
  };
  dependencies: {
    mongo: S10ProbeState;
    redis: S10ProbeState;
    postgres: S10ProbeState;
    s3: S10ProbeState;
  };
  modelProbe: {
    status: string;
    verificationStatus: S10VerificationStatus;
    latencyMs: number;
    modelCount?: number;
  };
  connectorProbes: Array<{
    connectorId?: string;
    provider: string;
    status: string;
    verificationStatus: S10VerificationStatus;
    lastAttemptAt?: string | null;
  }>;
  queueProbe: S10ProbeState;
  connectorProbe: S10ProbeState;
  securityChecks: {
    apiKeyHmacConfigured: boolean;
    scopeEnforced: boolean;
    auditAppendOnly: boolean;
    secretRedactionEnabled: boolean;
    rateLimitEnabled: boolean;
  };
  reconciliation: {
    lastRunAt: string | null;
    state: 'unknown' | 'ok' | 'degraded' | 'failed';
    orphanObjects: number;
    orphanVectors: number;
    diffCount: number;
    repairedCount: number;
  };
}

export interface S10StatusProbePort {
  probe(context: TenantContext): Promise<S10StatusView>;
}

function verificationHealthy(value: S10VerificationStatus): boolean {
  return value === 'REAL_VERIFIED';
}

export class S10StatusApplication {
  constructor(private readonly probes: S10StatusProbePort) {}

  async get(context: TenantContext): Promise<S10StatusView> {
    if (!context.scopes.includes('knowledge:admin')) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { scope: 'knowledge:admin' },
      });
    }
    if (context.apiKeySpaceIds && !isWorkspaceWideApiKey(context.apiKeySpaceIds)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'workspace_wide_api_key_required' },
      });
    }
    const view = await this.probes.probe(context).catch(() => this.unavailable());
    const dependenciesHealthy = Object.values(view.dependencies).every(
      (dependency) =>
        dependency.status === 'ok' && dependency.verificationStatus === 'REAL_VERIFIED',
    );
    const storageHealthy =
      view.storage.healthy && verificationHealthy(view.storage.verificationStatus);
    const vectorHealthy =
      view.vector.healthy && verificationHealthy(view.vector.verificationStatus);
    const modelHealthy = verificationHealthy(view.modelProbe.verificationStatus);
    const connectorsVerified = view.connectorProbes.every((entry) =>
      verificationHealthy(entry.verificationStatus),
    );
    const queueHealthy =
      view.queueProbe.status === 'ok' && verificationHealthy(view.queueProbe.verificationStatus);
    const connectorProbeHealthy =
      view.connectorProbe.status === 'ok' &&
      verificationHealthy(view.connectorProbe.verificationStatus);
    return {
      ...view,
      status:
        dependenciesHealthy &&
        storageHealthy &&
        vectorHealthy &&
        modelHealthy &&
        connectorsVerified &&
        queueHealthy &&
        connectorProbeHealthy &&
        view.reconciliation.state === 'ok'
          ? 'ok'
          : 'degraded',
      queueDepth: Object.fromEntries(
        Object.entries(view.queueLag).map(([name, counts]) => [
          name,
          counts.waiting + counts.delayed + counts.active + counts.failed,
        ]),
      ),
      storage: { ...view.storage, healthy: storageHealthy },
      vector: { ...view.vector, healthy: vectorHealthy },
    };
  }

  private unavailable(): S10StatusView {
    const down: S10ProbeState = {
      status: 'down',
      latencyMs: 0,
      verificationStatus: 'UNKNOWN',
      reason: 'probe_failed',
    };
    return {
      status: 'degraded',
      queueDepth: {},
      queueLag: {},
      storage: {
        provider: 'minio',
        healthy: false,
        verificationStatus: 'UNKNOWN',
      },
      vector: {
        backend: 'pgvector',
        healthy: false,
        profiles: [768, 1024, 1536, 3072],
        verificationStatus: 'UNKNOWN',
      },
      dependencies: { mongo: down, redis: down, postgres: down, s3: down },
      modelProbe: {
        status: 'unknown',
        verificationStatus: 'UNKNOWN',
        latencyMs: 0,
      },
      connectorProbes: [],
      queueProbe: down,
      connectorProbe: down,
      securityChecks: {
        apiKeyHmacConfigured: false,
        scopeEnforced: false,
        auditAppendOnly: false,
        secretRedactionEnabled: false,
        rateLimitEnabled: false,
      },
      reconciliation: {
        lastRunAt: null,
        state: 'unknown',
        orphanObjects: 0,
        orphanVectors: 0,
        diffCount: 0,
        repairedCount: 0,
      },
    };
  }
}
