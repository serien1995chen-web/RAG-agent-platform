import { createKnowledgeError } from '@kb/contracts';
import type { S8ImageTicketPort } from '../application/s8-image-deep.ports';
import type { FileTicketPort } from '../application/ports';

export class S8FileTicketAdapter implements S8ImageTicketPort {
  constructor(private readonly tickets: FileTicketPort) {}

  issueImage(input: Parameters<S8ImageTicketPort['issueImage']>[0]) {
    if (input.ttlSeconds < 60 || input.ttlSeconds > 3600) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { field: 'ttlSeconds', min: 60, max: 3600 },
      });
    }
    return this.tickets.issue(
      {
        workspaceId: input.workspaceId,
        blobId: input.blobId,
        sourceId: input.sourceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        disposition: 'inline',
        ttlSeconds: input.ttlSeconds,
      },
      input.context.requestId,
      input.context.traceId,
    );
  }
}
