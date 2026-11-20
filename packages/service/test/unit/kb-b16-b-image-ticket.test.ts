import { describe, expect, it, vi } from 'vitest';
import { S8FileTicketAdapter } from '../../src/modules/knowledge/adapter/s8-file-ticket.adapter';
import type { FileTicketPort } from '../../src/modules/knowledge/application/ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b16-b-ticket',
  memberId: 'mem-b16-b-ticket',
  requestId: 'req-b16-b-ticket',
  traceId: 'trace-b16-b-ticket'.padEnd(32, '0'),
  scopes: ['knowledge:read', 'knowledge:search'],
};

describe('L1-B16-B-SEARCH-005 image ticket boundaries', () => {
  it('binds a short-lived image ticket to workspace, source, space and current ACL', async () => {
    const issue = vi.fn<FileTicketPort['issue']>(async () => ({
      url: 'https://knowledge.example.invalid/v1/knowledge/files/blob/content?ticket=redacted',
      ticket: 'redacted',
      expiresAt: '2026-11-20T15:00:00.000Z',
    }));
    const adapter = new S8FileTicketAdapter({
      issue,
      verify: vi.fn(),
      consume: vi.fn(),
    });

    const result = await adapter.issueImage({
      workspaceId: context.workspaceId,
      context,
      blobId: '65f1e5b2a1c9d4b7e8f09501',
      sourceId: '65f1e5b2a1c9d4b7e8f09502',
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f09503',
      ttlSeconds: 300,
    });

    expect(result.url).toMatch(/^https:\/\//);
    expect(result.url).not.toContain('minio');
    expect(result.url).not.toContain('kb-test');
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: context.workspaceId,
        memberId: context.memberId,
        scopes: context.scopes,
        blobId: '65f1e5b2a1c9d4b7e8f09501',
        sourceId: '65f1e5b2a1c9d4b7e8f09502',
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f09503',
        disposition: 'inline',
        ttlSeconds: 300,
      }),
      context.requestId,
      context.traceId,
    );
  });

  it.each([0, 59, 3_601])('rejects image ticket TTL %s outside 60..3600 seconds', async (ttl) => {
    const adapter = new S8FileTicketAdapter({
      issue: vi.fn(),
      verify: vi.fn(),
      consume: vi.fn(),
    });

    await expect(
      adapter.issueImage({
        workspaceId: context.workspaceId,
        context,
        blobId: '65f1e5b2a1c9d4b7e8f09501',
        sourceId: '65f1e5b2a1c9d4b7e8f09502',
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f09503',
        ttlSeconds: ttl,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'ttlSeconds', min: 60, max: 3600 },
        },
      },
    });
  });
});
