import { Readable } from 'node:stream';
import { createKnowledgeError } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { FileTicketService } from '../../../../sdk/storage/src/file-ticket';
import { FileApplication } from '../../src/modules/knowledge/application/file.application';
import type {
  AccessPort,
  ObjectRefRepositoryPort,
  ObjectRefView,
} from '../../src/modules/knowledge/application/ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_ticket_order',
  memberId: 'mem_ticket_order',
  requestId: 'request-ticket-order',
  traceId: 'trace-ticket-order',
  scopes: ['knowledge:read'],
};

const ref: ObjectRefView = {
  blobId: '65f1e5b2a1c9d4b7e8f09abc',
  workspaceId: context.workspaceId,
  createdByMemberId: context.memberId,
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  provider: 'minio',
  bucket: 'kb-test',
  objectKey:
    'ws/ws_ticket_order/space/65f1e5b2a1c9d4b7e8f01234/source/source/export/blob/archive.zip',
  providerUploadId: null,
  uploadMode: 'single',
  uploadStatus: 'completed',
  pendingObjectKey: null,
  finalObjectKey: null,
  finalizedAt: null,
  pendingUrlExpiresAt: null,
  originalName: 'archive.zip',
  purpose: 'export',
  sourceId: '65f1e5b2a1c9d4b7e8f05678',
  mimeType: 'application/zip',
  sizeBytes: 2,
  etag: 'etag',
  sha256: 'sha',
  state: 'active',
  expiresAt: null,
  version: 1,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
  deletedAt: null,
};

describe('file ticket consume ordering', () => {
  it('does not consume a ticket when object acquisition fails and rejects replay after success', async () => {
    const tickets = new FileTicketService(
      'file-ticket-secret-that-is-at-least-32-bytes',
      'https://knowledge.example.invalid',
    );
    const issued = await tickets.issue(
      {
        workspaceId: context.workspaceId,
        memberId: context.memberId,
        isWorkspaceOwner: false,
        scopes: [...context.scopes],
        blobId: ref.blobId,
        sourceId: ref.sourceId,
        knowledgeSpaceId: ref.knowledgeSpaceId,
        disposition: 'attachment',
        ttlSeconds: 60,
      },
      context.requestId,
      context.traceId,
    );
    const ticket = new URL(issued.url).searchParams.get('ticket')!;
    let objectAttempts = 0;
    const files = new FileApplication(
      {
        async findObjectRef() {
          return ref;
        },
      } as unknown as ObjectRefRepositoryPort,
      {
        provider: 'minio',
        bucket: 'kb-test',
        async getObject() {
          objectAttempts += 1;
          if (objectAttempts === 1) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
              requestId: context.requestId,
              traceId: context.traceId,
              details: { dependency: 'minio' },
            });
          }
          return {
            body: Readable.from([Buffer.from('ok')]),
            size: 2,
            etag: 'etag',
            contentType: 'application/zip',
            contentRange: null,
          };
        },
      } as never,
      {} as never,
      {
        async assertPermission() {
          return { effectivePermission: 'read', permissionRevision: 1 };
        },
      } as unknown as AccessPort,
      tickets,
    );

    await expect(files.content(ref.blobId, null, ticket, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    const first = await files.content(ref.blobId, null, ticket, context);
    const chunks: Buffer[] = [];
    for await (const chunk of first.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('ok');
    await expect(files.content(ref.blobId, null, ticket, context)).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_FORBIDDEN',
          details: { reason: 'ticket_consumed' },
        },
      },
    });
  });
});
