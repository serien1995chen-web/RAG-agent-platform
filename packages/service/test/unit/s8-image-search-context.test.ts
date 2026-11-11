import { describe, expect, it } from 'vitest';
import { S8ImageSearchApplication } from '../../src/modules/knowledge/application/s8-image-search.application';
import type { ImageSearchApiRequest } from '@kb/contracts';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

describe('S8 image search tenant context', () => {
  it('passes the complete TenantContext into caption full-text recall', async () => {
    const received: TenantContext[] = [];
    const application = new S8ImageSearchApplication({
      fullText: {
        async search(_input: unknown, context: TenantContext) {
          received.push(context);
          return [];
        },
      },
      authorization: {
        async hydrate() {
          return { items: [], rejected: 0 };
        },
      },
    } as never);
    const context: TenantContext = {
      workspaceId: 'ws_s8_context',
      memberId: 'mem_s8_context',
      requestId: 'req_s8_context',
      traceId: 'trace-s8-context',
      scopes: ['knowledge:read', 'knowledge:search'],
      isWorkspaceOwner: true,
    };
    const request = {
      knowledgeSpaceId: '507f1f77bcf86cd799439011',
      query: 'refund flow',
      imageUploadIds: ['507f1f77bcf86cd799439012'],
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    } as ImageSearchApiRequest;

    await (
      application as unknown as {
        captionCandidates(
          input: ImageSearchApiRequest,
          allowedSourceIds: readonly string[],
          tenant: TenantContext,
        ): Promise<unknown>;
      }
    ).captionCandidates(request, ['507f1f77bcf86cd799439013'], context);

    expect(received).toEqual([context]);
  });
});
