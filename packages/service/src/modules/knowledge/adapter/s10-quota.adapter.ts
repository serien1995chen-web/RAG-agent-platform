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

// Provider timeout is 120s with up to three attempts; keep crash-safe leases
// beyond the complete retry window.
export const S10_MODEL_LEASE_TTL_SECONDS = 900;

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

  private async snapshot(context: TenantContext, fresh = false): Promise<S10UsageSummary> {
    const now = this.now();
    const key = `${context.workspaceId}:${this.input.quota.version}:local:${Math.floor(now.getTime() / 5_000)}`;
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.expiresAt > now.getTime()) return cached.value;
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
      await this.input.redis.decr(key);
      quotaError(context, 'requests_per_minute', this.input.quota.version, {
        limit: this.input.quota.requestsPerMinute,
      });
    }
  }

  private async reservePoints(
    context: TenantContext,
    snapshot: S10UsageSummary,
    estimatedPointsMicros: number,
  ): Promise<{ key: string; pointsMicros: number } | null> {
    const pointsMicros = Math.max(0, Math.trunc(estimatedPointsMicros));
    if (pointsMicros === 0) return null;
    const key = `kb:quota:points-reserved:${requireWorkspaceId(context)}`;
    const reserved = Number(await this.input.redis.incrby(key, pointsMicros));
    await this.input.redis.expire(key, S10_MODEL_LEASE_TTL_SECONDS);
    if (snapshot.usage.aiPointsMicros + reserved > snapshot.quota.aiPointsLimit * 1_000_000) {
      const remaining = await this.input.redis.decrby(key, pointsMicros);
      if (remaining <= 0) await this.input.redis.del(key);
      quotaError(context, 'ai_points', this.input.quota.version, {
        limit: snapshot.quota.aiPointsLimit * 1_000_000,
        used: snapshot.usage.aiPointsMicros,
        reserved,
        estimatedPointsMicros: pointsMicros,
      });
    }
    return { key, pointsMicros };
  }

  private async releaseReservation(
    reservation: { key: string; pointsMicros: number } | null,
  ): Promise<void> {
    if (!reservation) return;
    const remaining = await this.input.redis.decrby(reservation.key, reservation.pointsMicros);
    if (remaining <= 0) await this.input.redis.del(reservation.key);
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
    const snapshot = await this.snapshot(context, input.operation === 'model');
    if (input.operation === 'model') {
      if (
        snapshot.usage.aiPointsMicros + Math.max(0, input.estimatedPointsMicros ?? 0) >
        snapshot.quota.aiPointsLimit * 1_000_000
      ) {
        quotaError(context, 'ai_points', this.input.quota.version, {
          limit: snapshot.quota.aiPointsLimit * 1_000_000,
          used: snapshot.usage.aiPointsMicros,
          estimatedPointsMicros: Math.max(0, input.estimatedPointsMicros ?? 0),
        });
      }
    } else if (
      snapshot.usage.aiPointsMicros + Math.max(0, input.estimatedPointsMicros ?? 0) >
      snapshot.quota.aiPointsLimit * 1_000_000
    ) {
      quotaError(context, 'ai_points', this.input.quota.version, {
        limit: snapshot.quota.aiPointsLimit * 1_000_000,
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
    if (input.operation === 'import' || input.operation === 'sync') {
      await this.consumeRpm(context);
    }
  }

  async withModelSlot<T>(
    context: TenantContext,
    work: () => Promise<T>,
    estimatedPointsMicros = 0,
  ): Promise<T> {
    const workspaceId = requireWorkspaceId(context);
    const key = `kb:quota:model-concurrency:${workspaceId}`;
    let slotAcquired = false;
    let reservation: { key: string; pointsMicros: number } | null = null;
    try {
      const active = await this.input.redis.incr(key);
      await this.input.redis.expire(key, S10_MODEL_LEASE_TTL_SECONDS);
      if (active > this.input.quota.maxModelConcurrency) {
        await this.input.redis.decr(key);
        quotaError(context, 'model_concurrency', this.input.quota.version, {
          limit: this.input.quota.maxModelConcurrency,
        });
      }
      slotAcquired = true;
      reservation = await this.reservePoints(
        context,
        await this.snapshot(context, true),
        estimatedPointsMicros,
      );
      await this.consumeRpm(context);
      return await work();
    } finally {
      if (slotAcquired) {
        const remaining = await this.input.redis.decr(key);
        if (remaining <= 0) await this.input.redis.del(key);
      }
      await this.releaseReservation(reservation);
    }
  }
}
