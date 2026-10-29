import { createKnowledgeError } from '@kb/contracts';
import type Redis from 'ioredis';
import type { S10QuotaProfile } from '../../../shared/config/s10-profiles';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import type { QuotaGatePort } from '../application/ingestion.ports';
import type { S10UsageRepositoryPort, S10UsageSummary } from '../application/s10-operations.ports';

type QuotaKind =
  | 'ai_points'
  | 'storage_bytes'
  | 'indexes'
  | 'spaces'
  | 'requests_per_minute'
  | 'model_concurrency';

function quotaError(
  context: TenantContext,
  kind: QuotaKind,
  profileVersion: string,
  details: Record<string, unknown> = {},
): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_QUOTA_EXCEEDED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { quota: kind, profileVersion, ...details },
  });
}

export class KnowledgeQuotaGate implements QuotaGatePort {
  private readonly cache = new Map<string, { expiresAt: number; value: S10UsageSummary }>();

  constructor(
    private readonly input: {
      usage: S10UsageRepositoryPort;
      redis: Redis;
      quota: S10QuotaProfile;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private async snapshot(context: TenantContext): Promise<S10UsageSummary> {
    const now = this.now();
    const key = `${context.workspaceId}:${this.input.quota.version}:local:${Math.floor(now.getTime() / 5_000)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now.getTime()) return cached.value;
    const value = await this.input.usage.summary(
      {
        from: new Date(now.getTime() - this.input.quota.retentionDays * 86_400_000),
        to: now,
      },
      context,
    );
    this.cache.set(key, { expiresAt: now.getTime() + 5_000, value });
    for (const [entryKey, entry] of this.cache) {
      if (entry.expiresAt <= now.getTime()) this.cache.delete(entryKey);
    }
    return value;
  }

  private async consumeRpm(context: TenantContext): Promise<void> {
    const workspaceId = requireWorkspaceId(context);
    const minute = Math.floor(this.now().getTime() / 60_000);
    const key = `kb:quota:rpm:${workspaceId}:${minute}`;
    const count = await this.input.redis.incr(key);
    if (count === 1) await this.input.redis.expire(key, 90);
    if (count > this.input.quota.requestsPerMinute) {
      quotaError(context, 'requests_per_minute', this.input.quota.version, {
        limit: this.input.quota.requestsPerMinute,
      });
    }
  }

  async check(
    input: {
      operation: 'import' | 'sync' | 'rebuild' | 'model' | 'space';
      workspaceId: string;
      knowledgeSpaceId?: string;
      sourceCount?: number;
      sizeBytes?: number;
      estimatedPointsMicros?: number;
    },
    context: TenantContext,
  ): Promise<void> {
    if (input.workspaceId !== requireWorkspaceId(context)) {
      quotaError(context, 'ai_points', this.input.quota.version, {
        reason: 'workspace_mismatch',
      });
    }
    const snapshot = await this.snapshot(context);
    if (input.operation === 'model' || input.operation === 'import' || input.operation === 'sync') {
      await this.consumeRpm(context);
    }
    if (
      snapshot.usage.aiPointsMicros + Math.max(0, input.estimatedPointsMicros ?? 0) >
      snapshot.quota.aiPointsLimit * 1_000_000
    ) {
      quotaError(context, 'ai_points', this.input.quota.version, {
        limit: this.input.quota.aiPointsLimit * 1_000_000,
        used: snapshot.usage.aiPointsMicros,
      });
    }
    if (
      snapshot.usage.storageBytes + Math.max(0, input.sizeBytes ?? 0) >
      this.input.quota.storageBytesLimit
    ) {
      quotaError(context, 'storage_bytes', this.input.quota.version, {
        limit: this.input.quota.storageBytesLimit,
        used: snapshot.usage.storageBytes,
      });
    }
    if (
      snapshot.usage.indexCount + Math.max(0, input.sourceCount ?? 0) >
      this.input.quota.maxIndexes
    ) {
      quotaError(context, 'indexes', this.input.quota.version, {
        limit: this.input.quota.maxIndexes,
        used: snapshot.usage.indexCount,
      });
    }
    if (input.operation === 'space' && snapshot.usage.spaceCount >= this.input.quota.maxSpaces) {
      quotaError(context, 'spaces', this.input.quota.version, {
        limit: this.input.quota.maxSpaces,
        used: snapshot.usage.spaceCount,
      });
    }
  }

  async withModelSlot<T>(context: TenantContext, work: () => Promise<T>): Promise<T> {
    const workspaceId = requireWorkspaceId(context);
    const key = `kb:quota:model-concurrency:${workspaceId}`;
    const active = await this.input.redis.incr(key);
    await this.input.redis.expire(key, 60);
    if (active > this.input.quota.maxModelConcurrency) {
      await this.input.redis.decr(key);
      quotaError(context, 'model_concurrency', this.input.quota.version, {
        limit: this.input.quota.maxModelConcurrency,
      });
    }
    try {
      return await work();
    } finally {
      const remaining = await this.input.redis.decr(key);
      if (remaining <= 0) await this.input.redis.del(key);
    }
  }
}
