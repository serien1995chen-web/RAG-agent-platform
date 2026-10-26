import { createHash } from 'node:crypto';
import { Types, type Connection, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeUsageEventDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import type { S5GatewayUsageFact, S5UsageRecorderPort } from '../application/s5-model-gateway.port';
import type { S5ProviderUsageFact, S5ProviderUsageRecorderPort } from '../application/s5-ocr-ports';

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

export class S5UsageRepository implements S5UsageRecorderPort, S5ProviderUsageRecorderPort {
  private readonly usage: Model<KnowledgeUsageEventDoc>;

  constructor(private readonly connection: Connection) {
    this.usage = registerKnowledgeModels(connection).KnowledgeUsageEvent;
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
            status: fact.status,
            attempt: fact.attempt,
            fallbackUsed: fact.fallbackUsed,
            sourceVersion: fact.sourceVersion,
          },
        },
        context,
        session,
      );
      return true;
    });
  }
}
