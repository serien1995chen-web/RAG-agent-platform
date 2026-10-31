import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  S10UsageRepositoryPort,
  S10UsageSummary,
  S10UsageSummaryQuery,
} from '../application/s10-operations.ports';

export interface S10SharedUsageConfig {
  ingestUrl?: string;
  snapshotUrl?: string;
  token: string;
  profileVersion: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class KnowledgeSharedUsageAdapter {
  private readonly cache = new Map<string, { expiresAt: number; value: S10UsageSummary }>();

  constructor(
    private readonly config: S10SharedUsageConfig,
    private readonly local: S10UsageRepositoryPort,
  ) {}

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private error(
    context: TenantContext,
    code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' | 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
    reason: string,
  ): never {
    throw createKnowledgeError({
      code,
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        dependency: 'shared_usage',
        status: code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT' ? 'TIMEOUT' : 'EXTERNAL_UNVERIFIED',
        reason,
      },
    });
  }

  async snapshot(
    query: S10UsageSummaryQuery,
    context: TenantContext,
  ): Promise<{ source: 'shared' | 'local'; profileVersion: string; value: S10UsageSummary }> {
    if (!this.config.snapshotUrl) {
      return {
        source: 'local',
        profileVersion: this.config.profileVersion,
        value: await this.local.summary(query, context),
      };
    }
    const now = this.now();
    const cacheKey = [
      context.workspaceId,
      this.config.profileVersion,
      'shared',
      query.from.toISOString(),
      query.to.toISOString(),
      query.type ?? '',
      query.spaceId ?? '',
    ].join('|');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now.getTime()) {
      return { source: 'shared', profileVersion: this.config.profileVersion, value: cached.value };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5_000);
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(this.config.snapshotUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
          'x-workspace-id': context.workspaceId,
          'x-request-id': context.requestId,
        },
        body: JSON.stringify({
          from: query.from.toISOString(),
          to: query.to.toISOString(),
          type: query.type,
          spaceId: query.spaceId,
          profileVersion: this.config.profileVersion,
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted)
        this.error(context, 'KNOWLEDGE_DEPENDENCY_TIMEOUT', 'snapshot');
      this.error(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'snapshot');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) this.error(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'snapshot_status');
    const value = (await response.json()) as S10UsageSummary;
    this.cache.set(cacheKey, { expiresAt: now.getTime() + 5_000, value });
    return { source: 'shared', profileVersion: this.config.profileVersion, value };
  }

  async summary(query: S10UsageSummaryQuery, context: TenantContext): Promise<S10UsageSummary> {
    return (await this.snapshot(query, context)).value;
  }

  async deliverUsage(
    input: { eventId: string; payload: Record<string, unknown> },
    context: TenantContext,
  ): Promise<void> {
    if (!this.config.ingestUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5_000);
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(this.config.ingestUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
          'x-workspace-id': context.workspaceId,
          'x-request-id': context.requestId,
        },
        body: JSON.stringify({ eventId: input.eventId, fact: input.payload }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) this.error(context, 'KNOWLEDGE_DEPENDENCY_TIMEOUT', 'ingest');
      this.error(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'ingest');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) this.error(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'ingest_status');
  }
}
