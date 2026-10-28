import { createKnowledgeError } from '@kb/contracts';
import type { S06ProcessingApplication, TenantContext } from '@kb/service';

export type KnowledgeQueueOutcome = 'succeeded' | 'retry' | 'dead_letter';

export interface S06QueuePayload {
  outboxEventId: string;
  eventKey: string;
  workspaceId: string;
}

export class S06JobHandlers {
  constructor(private readonly processing: S06ProcessingApplication) {}

  private context(payload: S06QueuePayload, workerId: string): TenantContext {
    if (
      typeof payload.workspaceId !== 'string' ||
      payload.workspaceId.length === 0 ||
      typeof payload.outboxEventId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(payload.outboxEventId)
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: `worker:${workerId}`,
        traceId: `worker:${workerId}`,
        details: { reason: 'invalid_queue_payload' },
      });
    }
    return {
      workspaceId: payload.workspaceId,
      memberId: 'system:knowledge-worker',
      requestId: `worker:${payload.outboxEventId}`,
      traceId: `worker:${workerId}`,
      scopes: ['knowledge:admin'],
      isWorkspaceOwner: false,
    };
  }

  async import(payload: S06QueuePayload, workerId: string): Promise<KnowledgeQueueOutcome> {
    return this.processing.handleImport(
      payload.outboxEventId,
      workerId,
      this.context(payload, workerId),
    );
  }

  async queue(
    queue:
      | 'knowledge-parse'
      | 'knowledge-segment'
      | 'knowledge-qa'
      | 'knowledge-ocr'
      | 'knowledge-caption'
      | 'knowledge-embed'
      | 'knowledge-index'
      | 'knowledge-rebuild'
      | 'knowledge-sync'
      | 'knowledge-delete'
      | 'knowledge-outbox'
      | 'knowledge-cleanup',
    payload: S06QueuePayload,
    workerId: string,
  ): Promise<KnowledgeQueueOutcome> {
    const context = this.context(payload, workerId);
    const event = await this.processing.hydrateOutbox(payload.outboxEventId, context);
    if (event.workspaceId !== payload.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'queue_workspace_mismatch' },
      });
    }
    const jobId = String(event.payload.jobId ?? '');
    if (!/^[a-f0-9]{24}$/.test(jobId)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'outbox.payload.jobId' },
      });
    }
    return this.processing.handleQueue(queue, jobId, workerId, context);
  }
}
