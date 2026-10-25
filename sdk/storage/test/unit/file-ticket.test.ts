import { describe, expect, it } from 'vitest';
import { FileTicketService } from '../../src/file-ticket';

describe('file ticket service', () => {
  it('issues a configured public content URL and verifies all claims', () => {
    const service = new FileTicketService(
      'file-ticket-secret-that-is-at-least-32-bytes',
      'https://knowledge.example.invalid',
    );
    const issued = service.issue(
      {
        workspaceId: 'ws_ticket',
        blobId: '65f1e5b2a1c9d4b7e8f09abc',
        sourceId: '65f1e5b2a1c9d4b7e8f05678',
        knowledgeSpaceId: null,
        disposition: 'inline',
        ttlSeconds: 300,
      },
      'request-ticket',
      'trace-ticket',
    );
    expect(issued.url.startsWith('https://knowledge.example.invalid/v1/knowledge/files/')).toBe(
      true,
    );
    expect(service.verify(issued.ticket, 'request-ticket', 'trace-ticket')).toMatchObject({
      workspaceId: 'ws_ticket',
      blobId: '65f1e5b2a1c9d4b7e8f09abc',
      sourceId: '65f1e5b2a1c9d4b7e8f05678',
      disposition: 'inline',
    });
  });

  it('rejects expired and tampered tickets', () => {
    let now = Date.parse('2026-10-25T00:00:00.000Z');
    const service = new FileTicketService(
      'file-ticket-secret-that-is-at-least-32-bytes',
      'https://knowledge.example.invalid',
      () => now,
    );
    const issued = service.issue(
      {
        workspaceId: 'ws_ticket',
        blobId: '65f1e5b2a1c9d4b7e8f09abc',
        sourceId: null,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        disposition: 'attachment',
        ttlSeconds: 60,
      },
      'request-ticket',
      'trace-ticket',
    );
    expect(() => service.verify(`${issued.ticket}tampered`, 'request', 'trace')).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_FORBIDDEN' }),
        }),
      }),
    );
    now += 61_000;
    expect(() => service.verify(issued.ticket, 'request', 'trace')).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_FORBIDDEN' }),
        }),
      }),
    );
  });
});
