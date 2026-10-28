import { describe, expect, it } from 'vitest';
import { S7CitationApplication } from '../../packages/service/src/modules/knowledge/application/s7-citation.application';
import { S7CitationSigner } from '../../packages/service/src/modules/knowledge/adapter/s7-citation-signer';

const workspaceA = 'ws-tenant-citation-a';
const workspaceB = 'ws-tenant-citation-b';
const citationId = new S7CitationSigner('0123456789abcdef0123456789abcdef').issue(workspaceA);

describe('TEST-SEARCH-009-BLOCK citation tenant isolation', () => {
  it('rejects a citation from another workspace before repository access', async () => {
    let repositoryReads = 0;
    const signer = new S7CitationSigner('0123456789abcdef0123456789abcdef');
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
          repositoryReads += 1;
          return null;
        },
      },
      signer,
    });
    await expect(
      application.get(citationId, {
        workspaceId: workspaceB,
        memberId: 'member-b',
        requestId: 'request-b',
        traceId: 'trace-b',
        scopes: ['knowledge:search'],
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(repositoryReads).toBe(0);
  });
});
