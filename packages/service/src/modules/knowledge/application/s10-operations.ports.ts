import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S10ApiKeyAuthRecord, S10ApiKeyRecord, S10ApiKeyScope } from '../domain/s10-api-key';
import type { OperationPageInfo } from './ports';
import type { S10UsageKind } from '../domain/s10-usage';

export interface S10ApiKeyListQuery {
  cursor?: string;
  limit?: number;
  sort?: string;
}

export interface S10ApiKeyCreateInput {
  name: string;
  scopes: S10ApiKeyScope[];
  spaceIds: string[];
  expiresAt: Date | null;
}

export interface S10ApiKeyUpdateInput {
  name?: string;
  scopes?: S10ApiKeyScope[];
  spaceIds?: string[];
  status?: 'active' | 'revoked';
  version: number;
}

export interface S10ApiKeySecretInput {
  secretHash: string;
  keyPrefix: string;
}

export interface S10ApiKeyRepositoryPort {
  list(
    query: S10ApiKeyListQuery,
    context: TenantContext,
  ): Promise<{ items: S10ApiKeyRecord[]; pageInfo: OperationPageInfo }>;
  create(
    input: S10ApiKeyCreateInput,
    secret: S10ApiKeySecretInput,
    context: TenantContext,
  ): Promise<S10ApiKeyRecord>;
  update(
    keyId: string,
    input: S10ApiKeyUpdateInput,
    context: TenantContext,
  ): Promise<S10ApiKeyRecord>;
  revoke(keyId: string, expectedVersion: number, context: TenantContext): Promise<void>;
  rotate(
    keyId: string,
    expectedVersion: number,
    secret: S10ApiKeySecretInput,
    context: TenantContext,
  ): Promise<S10ApiKeyRecord>;
  findForAuthentication(
    workspaceId: string,
    prefix: string,
    context: TenantContext,
  ): Promise<S10ApiKeyAuthRecord | null>;
  markUsed(keyId: string, now: Date, context: TenantContext): Promise<void>;
}

export interface S10UsageSummaryQuery {
  from: Date;
  to: Date;
  type?: S10UsageKind;
  spaceId?: string;
}

export interface S10UsageSummary {
  period: { from: string; to: string };
  quota: {
    aiPointsLimit: number;
    aiPointsLimitMicros: number;
    storageBytesLimit: number;
    maxSpaces: number;
    maxIndexes: number;
    requestsPerMinute: number;
    maxModelConcurrency: number;
    profileVersion: string;
  };
  usage: {
    aiPoints: number;
    aiPointsMicros: number;
    storageBytes: number;
    indexCount: number;
    spaceCount: number;
    parsePages: number;
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
    rerankTokens: number;
    modelCalls: number;
  };
  delivery: {
    pending: number;
    delivered: number;
    failed: number;
  };
  series: Array<{
    bucketStart: string;
    pointsMicros: number;
    inputTokens: number;
    outputTokens: number;
    pages: number;
    storageBytes: number;
  }>;
  profileVersion: string;
}

export interface S10UsageRepositoryPort {
  summary(query: S10UsageSummaryQuery, context: TenantContext): Promise<S10UsageSummary>;
}

export interface S10AuditListQuery {
  cursor?: string;
  limit?: number;
  action?: string;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'allowed' | 'denied' | 'succeeded' | 'failed';
  from?: Date;
  to?: Date;
}

export interface S10AuditView {
  eventId: string;
  workspaceId: string;
  knowledgeSpaceId: string | null;
  action: string;
  actorMemberId: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  resourceType: string;
  resourceId: string;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  traceId: string;
  requestId: string;
  ipHash: string;
  userAgentHash: string;
  safeDiff: Record<string, unknown>;
  occurredAt: string;
  expiresAt: string;
}

export interface S10AuditQueryPort {
  list(
    query: S10AuditListQuery,
    context: TenantContext,
  ): Promise<{ items: S10AuditView[]; pageInfo: OperationPageInfo }>;
}

export interface S10OpsJobView {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: 'cleanup' | 'reconcile' | 'outbox';
  status:
    | 'queued'
    | 'leased'
    | 'running'
    | 'retry_wait'
    | 'paused'
    | 'cancelling'
    | 'cancelled'
    | 'failed'
    | 'dead_letter'
    | 'succeeded';
  operationId: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: {
    stage: string;
    completed: number;
    total: number;
    percent: number;
  };
  createdAt: string;
  updatedAt: string;
  resourceType: 'workspace' | 'system';
  resourceId: string;
  version: number;
}

export interface S10OpsRepositoryPort {
  createCleanupJob(
    input: { scope: string; idempotencyKey: string },
    context: TenantContext,
  ): Promise<S10OpsJobView>;
  createReconcileJob(
    input: { scope: string; repair: boolean; idempotencyKey: string },
    context: TenantContext,
  ): Promise<S10OpsJobView>;
  replayOutbox(
    input: { eventId: string; version: number; idempotencyKey: string },
    context: TenantContext,
  ): Promise<{ id: string; status: 'accepted'; jobId: string }>;
  failOutboxDelivery(
    input: {
      outboxEventId: string;
      eventId: string;
      errorCode: string;
      deadLetter: boolean;
    },
    context: TenantContext,
  ): Promise<void>;
  recoverStaleJobs(context: TenantContext): Promise<number>;
}
