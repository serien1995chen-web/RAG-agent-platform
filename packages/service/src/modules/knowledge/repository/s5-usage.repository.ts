import { createHash } from 'node:crypto';
import { Types, type Connection, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeUsageEventDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import type { S5GatewayUsageFact, S5UsageRecorderPort } from '../application/s5-model-gateway.port';
import type { S5ProviderUsageFact, S5ProviderUsageRecorderPort } from '../application/s5-ocr-ports';
import {
  FREE_V1_QUOTA,
  ZERO_V1_PRICING,
  type S10PricingProfile,
  type S10QuotaProfile,
} from '../../../shared/config/s10-profiles';
import { computeUsagePointsMicros, pointsFromMicros } from '../domain/s10-usage';
import type {
  S10UsageRepositoryPort,
  S10UsageSummary,
  S10UsageSummaryQuery,
} from '../application/s10-operations.ports';

export function usageEventIdOf(input: {
  workspaceId: string;
  operation: string;
  requestId: string;
  modelId: string;
  kind: string;
  attempt: number;
  eventSequence: number;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.operation,
        input.requestId,
        input.modelId,
        input.kind,
        input.attempt,
        input.eventSequence,
      ].join('|'),
    )
    .digest('hex');
}

function objectIdOf(value: string): Types.ObjectId {
  if (Types.ObjectId.isValid(value)) return new Types.ObjectId(value);
  return new Types.ObjectId(createHash('sha256').update(value).digest('hex').slice(0, 24));
}

export class S5UsageRepository
  implements S5UsageRecorderPort, S5ProviderUsageRecorderPort, S10UsageRepositoryPort
{
  private readonly usage: Model<KnowledgeUsageEventDoc>;
  private readonly audit: KnowledgeAuditRepository;
  private readonly pricing: S10PricingProfile;
  private readonly quota: S10QuotaProfile;
  private readonly models: ReturnType<typeof registerKnowledgeModels>;

  constructor(
    private readonly connection: Connection,
    pricing: S10PricingProfile = ZERO_V1_PRICING,
    quota: S10QuotaProfile = FREE_V1_QUOTA,
  ) {
    this.models = registerKnowledgeModels(connection);
    this.usage = this.models.KnowledgeUsageEvent;
    this.audit = new KnowledgeAuditRepository(connection);
    this.pricing = pricing;
    this.quota = quota;
  }

  async recordInvocationUsage(fact: S5GatewayUsageFact, context: TenantContext): Promise<boolean> {
    const workspaceId = requireWorkspaceId(context);
    if (fact.workspaceId !== workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'workspaceId', reason: 'tenant_mismatch' },
      });
    }
    const eventId = usageEventIdOf({
      workspaceId,
      operation: fact.operation,
      requestId: fact.requestId,
      modelId: fact.modelId,
      kind: fact.kind,
      attempt: fact.attempt,
      eventSequence: fact.eventSequence,
    });
    const eventType =
      fact.kind === 'embedding' ? 'embedding' : fact.kind === 'rerank' ? 'rerank' : fact.kind;
    const inputTokens = Math.max(0, fact.inputTokens ?? 0);
    const outputTokens = Math.max(0, fact.outputTokens ?? 0);
    const pointsMicros = computeUsagePointsMicros({
      kind: fact.kind,
      status: fact.status,
      intent: fact.intent === true,
      quantity: fact.quantity,
      unit: fact.unit,
      inputTokens,
      outputTokens,
      pricing: this.pricing,
    });
    return withMongoTransaction(this.connection, async (session) => {
      const now = new Date();
      const result = await this.usage.updateOne(
        { workspaceId, eventId },
        {
          $setOnInsert: {
            workspaceId,
            knowledgeSpaceId: fact.knowledgeSpaceId ? objectIdOf(fact.knowledgeSpaceId) : null,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            eventId,
            eventType,
            quantity: fact.quantity,
            unit: fact.unit,
            inputTokens,
            outputTokens,
            pointsMicros,
            pricingVersion: this.pricing.version,
            pricingSnapshot: { ...this.pricing },
            modelId: fact.modelId,
            resourceType: fact.resourceType,
            resourceId: objectIdOf(fact.resourceId),
            jobId: null,
            source: 'api',
            occurredAt: now,
            deliveredAt: null,
            deliveryStatus: 'pending',
            expiresAt: new Date(now.getTime() + 730 * 86_400_000),
          },
        },
        { upsert: true, session },
      );
      if (result.upsertedCount !== 1) return false;
      await createKnowledgeOutboxEvent(
        this.connection,
        {
          workspaceId,
          knowledgeSpaceId: fact.knowledgeSpaceId,
          eventType: 'usage.recorded',
          aggregateType: 'usage_event',
          aggregateId: eventId,
          queue: 'knowledge-outbox',
          payload: {
            usageEventId: eventId,
            eventType,
            modelId: fact.modelId,
            provider: fact.provider,
            quantity: fact.quantity,
            unit: fact.unit,
            inputTokens,
            outputTokens,
            pointsMicros,
            pricingVersion: this.pricing.version,
            status: fact.status,
            attempt: fact.attempt,
            fallbackUsed: fact.fallbackUsed,
          },
        },
        context,
        session,
      );
      await this.audit.append(
        {
          knowledgeSpaceId: fact.knowledgeSpaceId,
          action: 'model.invoke',
          resourceType: fact.resourceType,
          resourceId: fact.resourceId,
          outcome: fact.intent
            ? 'allowed'
            : fact.status !== null && fact.status >= 200 && fact.status < 300
              ? 'succeeded'
              : 'failed',
          safeDiff: {
            modelId: fact.modelId,
            kind: fact.kind,
            provider: fact.provider,
            quantity: fact.quantity,
            unit: fact.unit,
            status: fact.status,
            attempt: fact.attempt,
            fallbackUsed: fact.fallbackUsed,
            intent: fact.intent === true,
            ...(fact.promptVersion ? { promptVersion: fact.promptVersion } : {}),
            ...(fact.mediaItemCount !== undefined ? { mediaItemCount: fact.mediaItemCount } : {}),
            ...(fact.totalBytes !== undefined ? { totalBytes: fact.totalBytes } : {}),
            ...(fact.sourceVersion !== undefined ? { sourceVersion: fact.sourceVersion } : {}),
          },
        },
        context,
        session,
      );
      return true;
    });
  }

  async recordProviderUsage(fact: S5ProviderUsageFact, context: TenantContext): Promise<boolean> {
    const workspaceId = requireWorkspaceId(context);
    if (fact.workspaceId !== workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'workspaceId', reason: 'tenant_mismatch' },
      });
    }
    const eventId = usageEventIdOf({
      workspaceId,
      operation: 'ocr',
      requestId: fact.requestId,
      modelId: `provider:${fact.provider}`,
      kind: 'ocr',
      attempt: fact.attempt,
      eventSequence: fact.eventSequence,
    });
    const pointsMicros = computeUsagePointsMicros({
      kind: 'ocr',
      status: fact.status,
      intent: fact.quantity === 0,
      quantity: fact.quantity,
      unit: fact.unit,
      pricing: this.pricing,
    });
    return withMongoTransaction(this.connection, async (session) => {
      const now = new Date();
      const result = await this.usage.updateOne(
        { workspaceId, eventId },
        {
          $setOnInsert: {
            workspaceId,
            knowledgeSpaceId: objectIdOf(fact.knowledgeSpaceId),
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            eventId,
            eventType: 'ocr',
            quantity: fact.quantity,
            unit: fact.unit,
            inputTokens: 0,
            outputTokens: 0,
            pointsMicros,
            pricingVersion: this.pricing.version,
            pricingSnapshot: { ...this.pricing },
            modelId: null,
            resourceType: 'source',
            resourceId: objectIdOf(fact.sourceId),
            jobId: null,
            source: 'api',
            occurredAt: now,
            deliveredAt: null,
            deliveryStatus: 'pending',
            expiresAt: new Date(now.getTime() + 730 * 86_400_000),
          },
        },
        { upsert: true, session },
      );
      if (result.upsertedCount !== 1) return false;
      await createKnowledgeOutboxEvent(
        this.connection,
        {
          workspaceId,
          knowledgeSpaceId: fact.knowledgeSpaceId,
          eventType: 'usage.recorded',
          aggregateType: 'usage_event',
          aggregateId: eventId,
          queue: 'knowledge-outbox',
          payload: {
            usageEventId: eventId,
            eventType: 'ocr',
            provider: fact.provider,
            quantity: fact.quantity,
            unit: fact.unit,
            pointsMicros,
            pricingVersion: this.pricing.version,
            status: fact.status,
            attempt: fact.attempt,
            fallbackUsed: fact.fallbackUsed,
            sourceVersion: fact.sourceVersion,
          },
        },
        context,
        session,
      );
      await this.audit.append(
        {
          knowledgeSpaceId: fact.knowledgeSpaceId,
          action: 'ocr.invoke',
          resourceType: 'source',
          resourceId: fact.sourceId,
          outcome:
            fact.status !== null && fact.status >= 200 && fact.status < 300
              ? 'succeeded'
              : 'failed',
          safeDiff: {
            provider: fact.provider,
            sourceVersion: fact.sourceVersion,
            quantity: fact.quantity,
            unit: fact.unit,
            status: fact.status,
            attempt: fact.attempt,
            fallbackUsed: fact.fallbackUsed,
          },
        },
        context,
        session,
      );
      return true;
    });
  }

  async deliverUsage(): Promise<void> {
    // Local-only usage is delivered when the outbox worker completes.
  }

  async markDelivery(
    eventId: string,
    status: 'delivered' | 'failed',
    context: TenantContext,
  ): Promise<void> {
    const workspaceId = requireWorkspaceId(context);
    const now = new Date();
    await this.usage.updateOne(
      {
        workspaceId,
        eventId,
        deletedAt: null,
        deliveryStatus: { $ne: status },
      },
      {
        $set: {
          deliveryStatus: status,
          deliveredAt: status === 'delivered' ? now : null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
    );
  }

  async summary(query: S10UsageSummaryQuery, context: TenantContext): Promise<S10UsageSummary> {
    const workspaceId = requireWorkspaceId(context);
    const match = {
      workspaceId,
      deletedAt: null,
      occurredAt: { $gte: query.from, $lte: query.to },
      ...(query.type ? { eventType: query.type } : {}),
      ...(query.spaceId ? { knowledgeSpaceId: new Types.ObjectId(query.spaceId) } : {}),
    };
    const [usageRows, deliveryRows, seriesRows, storage, indexRows, spaceCount] = await Promise.all(
      [
        this.usage.aggregate<{
          aiPointsMicros: number;
          inputTokens: number;
          outputTokens: number;
          parsePages: number;
          embeddingTokens: number;
          rerankTokens: number;
          modelCalls: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: null,
              aiPointsMicros: { $sum: { $ifNull: ['$pointsMicros', 0] } },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              parsePages: {
                $sum: { $cond: [{ $eq: ['$unit', 'page'] }, '$quantity', 0] },
              },
              embeddingTokens: {
                $sum: {
                  $cond: [
                    { $eq: ['$eventType', 'embedding'] },
                    { $ifNull: ['$inputTokens', '$quantity'] },
                    0,
                  ],
                },
              },
              rerankTokens: {
                $sum: {
                  $cond: [
                    { $eq: ['$eventType', 'rerank'] },
                    { $ifNull: ['$inputTokens', '$quantity'] },
                    0,
                  ],
                },
              },
              modelCalls: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $in: ['$eventType', ['llm', 'vlm', 'stt', 'tts']] },
                        { $gt: ['$quantity', 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
        this.usage.aggregate<{ _id: string; count: number }>([
          { $match: match },
          { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
        ]),
        this.usage.aggregate<{
          _id: string;
          pointsMicros: number;
          inputTokens: number;
          outputTokens: number;
          pages: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%dT00:00:00.000Z',
                  date: '$occurredAt',
                  timezone: 'UTC',
                },
              },
              pointsMicros: { $sum: { $ifNull: ['$pointsMicros', 0] } },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              pages: {
                $sum: { $cond: [{ $eq: ['$unit', 'page'] }, '$quantity', 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        this.models.KnowledgeObjectRef.aggregate<{ total: number }>([
          {
            $match: {
              workspaceId,
              deletedAt: null,
              state: { $in: ['pending', 'active'] },
              ...(query.spaceId ? { knowledgeSpaceId: new Types.ObjectId(query.spaceId) } : {}),
            },
          },
          { $group: { _id: null, total: { $sum: '$sizeBytes' } } },
        ]),
        this.models.KnowledgeSegment.aggregate<{ total: number }>([
          {
            $match: {
              workspaceId,
              deletedAt: null,
              ...(query.spaceId ? { knowledgeSpaceId: new Types.ObjectId(query.spaceId) } : {}),
            },
          },
          { $project: { count: { $size: { $ifNull: ['$indexes', []] } } } },
          { $group: { _id: null, total: { $sum: '$count' } } },
        ]),
        this.models.KnowledgeSpace.countDocuments({
          workspaceId,
          deletedAt: null,
          status: 'active',
          ...(query.spaceId ? { _id: new Types.ObjectId(query.spaceId) } : {}),
        }),
      ],
    );
    const usage = usageRows[0] ?? {
      aiPointsMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      parsePages: 0,
      embeddingTokens: 0,
      rerankTokens: 0,
      modelCalls: 0,
    };
    const deliveries = Object.fromEntries(deliveryRows.map((row) => [row._id, Number(row.count)]));
    return {
      period: { from: query.from.toISOString(), to: query.to.toISOString() },
      quota: {
        aiPointsLimit: this.quota.aiPointsLimit,
        aiPointsLimitMicros: this.quota.aiPointsLimit * 1_000_000,
        storageBytesLimit: this.quota.storageBytesLimit,
        maxSpaces: this.quota.maxSpaces,
        maxIndexes: this.quota.maxIndexes,
        requestsPerMinute: this.quota.requestsPerMinute,
        maxModelConcurrency: this.quota.maxModelConcurrency,
        profileVersion: this.quota.version,
      },
      usage: {
        aiPoints: pointsFromMicros(Number(usage.aiPointsMicros)),
        aiPointsMicros: Number(usage.aiPointsMicros),
        storageBytes: Number(storage[0]?.total ?? 0),
        indexCount: Number(indexRows[0]?.total ?? 0),
        spaceCount: Number(spaceCount),
        parsePages: Number(usage.parsePages),
        inputTokens: Number(usage.inputTokens),
        outputTokens: Number(usage.outputTokens),
        embeddingTokens: Number(usage.embeddingTokens),
        rerankTokens: Number(usage.rerankTokens),
        modelCalls: Number(usage.modelCalls),
      },
      delivery: {
        pending: Number(deliveries.pending ?? 0),
        delivered: Number(deliveries.delivered ?? 0),
        failed: Number(deliveries.failed ?? 0),
      },
      series: seriesRows.map((row) => ({
        bucketStart: row._id,
        pointsMicros: Number(row.pointsMicros),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        pages: Number(row.pages),
        storageBytes: 0,
      })),
      profileVersion: this.pricing.version,
    };
  }
}
