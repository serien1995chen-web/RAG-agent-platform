import { createKnowledgeError } from '../../packages/contracts/src/index';
import { S7CitationApplication } from '../../packages/service/src/modules/knowledge/application/s7-citation.application';
import { S7CitationSigner } from '../../packages/service/src/modules/knowledge/adapter/s7-citation-signer';
import { describe, expect, it } from 'vitest';

const context = {
  workspaceId: 'ws-citation-fault',
  memberId: 'mem-citation-fault',
  requestId: 'req-citation-fault',
  traceId: 'trace-citation-fault',
  scopes: ['knowledge:search'],
};
const signer = new S7CitationSigner('0123456789abcdef0123456789abcdef');

describe('TEST-SEARCH-009-BLOCK citation dependency faults', () => {
  it('does not convert citation store failure into not-found or empty success', async () => {
    const citationId = signer.issue(context.workspaceId);
    const application = new S7CitationApplication({
      access: {
        assertSearchScope() {},
        async getAuthorizedSpace() {
          throw new Error('not used');
        },
      },
      authorizations: {
        async hydrate() {
          return { items: [], rejected: 0 };
        },
        async reauthorizeCitation() {
          return undefined;
        },
      },
      citations: {
        async issueWithAudit() {
          return new Map();
        },
        async findCurrent() {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: {},
          });
        },
      },
      signer,
    });
    await expect(application.get(citationId, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
  });
});
