import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import {
  KNOWLEDGE_QUEUE_NAMES,
  buildKnowledgeJobId,
  type KnowledgeQueueName,
  type QueuePort,
} from '@kb/dal';
import { createKnowledgeError } from '@kb/contracts';
import { registerKnowledgeModels } from '../schemas/knowledge-index';
import type { KnowledgeOutboxEventDoc } from '../schemas/knowledge-job.schemas';
import { requireWorkspaceId, type TenantContext } from './tenant';

export interface CreateKnowledgeOutboxEventInput {
  workspaceId: string;
  knowledgeSpaceId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  queue: KnowledgeQueueName;
  payload: Record<string, unknown>;
  ttlDays?: number;
}

function stableEventKey(input: CreateKnowledgeOutboxEventInput): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.knowledgeSpaceId ?? '',
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
      ].join('|'),
    )
    .digest('hex');
}

export async function createKnowledgeOutboxEvent(
  connection: Connection,
  input: CreateKnowledgeOutboxEventInput,
  context: TenantContext,
  session: ClientSession,
): Promise<KnowledgeOutboxEventDoc> {
  const tenantWorkspaceId = requireWorkspaceId(context);
  if (!input.queue || !(KNOWLEDGE_QUEUE_NAMES as readonly string[]).includes(input.queue)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'queue', reason: 'not_canonical' },
    });
  }
  if (input.workspaceId !== tenantWorkspaceId) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'workspaceId', reason: 'tenant_mismatch' },
    });
  }
  registerKnowledgeModels(connection);
  const model = connection.models.KnowledgeOutboxEvent;
  if (!model) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { reason: 'outbox_model_missing' },
    });
  }
  const expiresAt = new Date(Date.now() + (input.ttlDays ?? 30) * 86_400_000);
  const [event] = await model.create(
    [
      {
        workspaceId: tenantWorkspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId
          ? new Types.ObjectId(input.knowledgeSpaceId)
          : null,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: stableEventKey(input),
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: { ...input.payload, queue: input.queue },
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        publishedAt: null,
        error: null,
        expiresAt,
      },
    ],
    { session },
  );
  if (!event) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { reason: 'outbox_create_failed' },
    });
  }
  return event.toObject() as KnowledgeOutboxEventDoc;
}

export class KnowledgeOutboxDispatcher {
  constructor(
    private readonly connection: Connection,
    private readonly queue: QueuePort,
  ) {
    registerKnowledgeModels(connection);
  }

  async dispatchOnce(context: TenantContext): Promise<{ dispatched: boolean; eventKey?: string }> {
    const workspaceId = requireWorkspaceId(context);
    const model = this.connection.models.KnowledgeOutboxEvent;
    if (!model) return { dispatched: false };
    const now = new Date();
    const event = await model.findOneAndUpdate(
      {
        workspaceId,
        status: 'pending',
        availableAt: { $lte: now },
      },
      {
        $set: { status: 'publishing', updatedByMemberId: context.memberId },
        $inc: { version: 1, attempts: 1 },
      },
      { new: true, sort: { availableAt: 1 } },
    );
    if (!event) return { dispatched: false };

    const queueName = String(event.payload.queue ?? '') as KnowledgeQueueName;
    if (!(KNOWLEDGE_QUEUE_NAMES as readonly string[]).includes(queueName)) {
      await model.updateOne(
        { _id: event._id, workspaceId, version: event.version },
        {
          $set: {
            status: 'dead_letter',
            error: { code: 'KNOWLEDGE_VALIDATION_FAILED', field: 'queue' },
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
      );
      return { dispatched: false, eventKey: event.eventKey };
    }
    const inputHash = createHash('sha256').update(JSON.stringify(event.payload)).digest('hex');
    const jobId = buildKnowledgeJobId({
      kind: 'outbox',
      resourceId: event.eventKey,
      version: event.version,
      inputHash,
    });
    try {
      await this.queue.enqueue(queueName, jobId, {
        outboxEventId: String(event._id),
        eventKey: event.eventKey,
        workspaceId: event.workspaceId,
        payload: event.payload,
      });
      await model.updateOne(
        { _id: event._id, workspaceId, version: event.version },
        {
          $set: {
            status: 'published',
            publishedAt: new Date(),
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
      );
      return { dispatched: true, eventKey: event.eventKey };
    } catch {
      const retryAt = new Date(Date.now() + Math.min(30_000, 1_000 * 2 ** event.attempts));
      await model.updateOne(
        { _id: event._id, workspaceId, version: event.version },
        {
          $set: {
            status: event.attempts >= 10 ? 'dead_letter' : 'failed',
            availableAt: retryAt,
            error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', operation: 'outbox_publish' },
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
      );
      return { dispatched: false, eventKey: event.eventKey };
    }
  }

  async replay(eventId: string, context: TenantContext): Promise<boolean> {
    const workspaceId = requireWorkspaceId(context);
    const model = this.connection.models.KnowledgeOutboxEvent;
    if (!model) return false;
    const result = await model.updateOne(
      {
        _id: eventId,
        workspaceId,
        status: { $in: ['failed', 'dead_letter'] },
      },
      {
        $set: {
          status: 'pending',
          availableAt: new Date(),
          error: null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1;
  }
}
