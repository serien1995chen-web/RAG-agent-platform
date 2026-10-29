'use client';

import { knowledgeRequest } from './knowledge-client';

export type S10ApiKeyStatus = 'active' | 'rotated' | 'revoked' | 'expired';
export type S10ApiKeyScope =
  | 'knowledge:read'
  | 'knowledge:search'
  | 'knowledge:write'
  | 'knowledge:manage'
  | 'knowledge:admin';

export interface S10ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  scopes: S10ApiKeyScope[];
  spaceIds: string[];
  status: S10ApiKeyStatus;
  expiresAt: string | null;
  retireAt: string | null;
  lastUsedAt: string | null;
  rotatedFromKeyId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface S10ApiKeyList {
  items: S10ApiKey[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface S10ApiKeySecret extends S10ApiKey {
  secret: string;
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
  delivery: { pending: number; delivered: number; failed: number };
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

export interface S10AuditEvent {
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

export interface S10AuditList {
  items: S10AuditEvent[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface S10Status {
  status: 'ok' | 'degraded';
  queueDepth: Record<string, number>;
  queueLag: Record<
    string,
    { waiting: number; delayed: number; active: number; failed: number; lag: number }
  >;
  storage: { provider: string; healthy: boolean; verificationStatus: string };
  vector: { backend: 'pgvector'; healthy: boolean; profiles: number[]; verificationStatus: string };
  dependencies: Record<
    'mongo' | 'redis' | 'postgres' | 's3',
    { status: string; latencyMs: number; verificationStatus: string; reason?: string }
  >;
  modelProbe: {
    status: string;
    verificationStatus: string;
    latencyMs: number;
    modelCount?: number;
  };
  connectorProbes: Array<{
    connectorId?: string;
    provider: string;
    status: string;
    verificationStatus: string;
    lastAttemptAt?: string | null;
  }>;
  queueProbe: {
    status: string;
    latencyMs: number;
    verificationStatus: string;
    reason?: string;
  };
  connectorProbe: {
    status: string;
    latencyMs: number;
    verificationStatus: string;
    reason?: string;
  };
  securityChecks: Record<string, boolean>;
  reconciliation: {
    lastRunAt: string | null;
    state: string;
    orphanObjects: number;
    orphanVectors: number;
    diffCount: number;
    repairedCount: number;
  };
}

export interface S10OpsJob {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: string;
  status: string;
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

function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function usagePath(params: Record<string, string | undefined> = {}): string {
  const query = queryString(params);
  return `/v1/knowledge/usage${query ? `?${query}` : ''}`;
}

export function auditPath(params: Record<string, string | undefined> = {}): string {
  const query = queryString(params);
  return `/v1/knowledge/audit-events${query ? `?${query}` : ''}`;
}

export function apiKeysPath(params: Record<string, string | undefined> = {}): string {
  const query = queryString(params);
  return `/v1/knowledge/api-keys${query ? `?${query}` : ''}`;
}

export function fetchUsage(
  params: Record<string, string | undefined> = {},
): Promise<S10UsageSummary> {
  return knowledgeRequest<S10UsageSummary>(usagePath(params));
}

export function listAudit(params: Record<string, string | undefined> = {}): Promise<S10AuditList> {
  return knowledgeRequest<S10AuditList>(auditPath(params));
}

export function listApiKeys(
  params: Record<string, string | undefined> = {},
): Promise<S10ApiKeyList> {
  return knowledgeRequest<S10ApiKeyList>(apiKeysPath(params));
}

export function createApiKey(
  input: {
    name: string;
    scopes: S10ApiKeyScope[];
    spaceIds: string[];
    expiresAt?: string | null;
  },
  idempotencyKey?: string,
): Promise<S10ApiKeySecret> {
  return knowledgeRequest<S10ApiKeySecret>('/v1/knowledge/api-keys', {
    method: 'POST',
    body: input,
    idempotencyKey,
  });
}

export function updateApiKey(
  keyId: string,
  input: {
    name?: string;
    scopes?: S10ApiKeyScope[];
    spaceIds?: string[];
    status?: 'active' | 'revoked';
    version: number;
  },
): Promise<S10ApiKey> {
  return knowledgeRequest<S10ApiKey>(`/v1/knowledge/api-keys/${keyId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function rotateApiKey(
  keyId: string,
  version: number,
  idempotencyKey?: string,
): Promise<S10ApiKeySecret> {
  return knowledgeRequest<S10ApiKeySecret>(`/v1/knowledge/api-keys/${keyId}/rotate`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
}

export function deleteApiKey(
  keyId: string,
  expectedVersion: number,
  idempotencyKey?: string,
): Promise<void> {
  return knowledgeRequest<void>(
    `/v1/knowledge/api-keys/${keyId}?expectedVersion=${expectedVersion}`,
    { method: 'DELETE', idempotencyKey },
  );
}

export function fetchStatus(): Promise<S10Status> {
  return knowledgeRequest<S10Status>('/v1/knowledge/operations/status');
}

export function cleanup(scope: string, idempotencyKey?: string): Promise<S10OpsJob> {
  return knowledgeRequest<S10OpsJob>('/v1/knowledge/operations/cleanup', {
    method: 'POST',
    body: { scope },
    idempotencyKey,
  });
}

export function reconcile(
  scope: string,
  repair: boolean,
  idempotencyKey?: string,
): Promise<S10OpsJob> {
  return knowledgeRequest<S10OpsJob>('/v1/knowledge/operations/reconcile', {
    method: 'POST',
    body: { scope, repair },
    idempotencyKey,
  });
}
