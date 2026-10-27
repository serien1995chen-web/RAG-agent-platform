import { describe, expect, it } from 'vitest';
import { S7CitationApplication } from '../../src/modules/knowledge/application/s7-citation.application';
import type { AuthorizedCandidate } from '@kb/search';
import type { S7CitationReaderRecord } from '../../src/modules/knowledge/application/s7-search.ports';
import { S7CitationSigner } from '../../src/modules/knowledge/adapter/s7-citation-signer';
import { citationSnapshotHash } from '../../src/modules/knowledge/repository/s7-citation.repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const workspaceId = 'ws_citation';
const context: TenantContext = {
  workspaceId,
  memberId: 'mem_citation',
  requestId: 'req_citation',
  traceId: 'trace_citation',
  scopes: ['knowledge:search'],
};
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f10001';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';

function candidate(): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId,
    knowledgeSpaceId: spaceId,
    score: 0.8,
    scores: [],
    text: 'Refunds take five days.',
    citationRange: { start: 0, end: [...'Refunds take five days.'].length },
    segment: {
      id: segmentId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId,
      order: 0,
      searchEnabled: true,
      question: 'Refunds take five days.',
      answer: '',
      content: 'Refunds take five days.',
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 4,
    },
    source: {
      id: sourceId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      name: 'Policy',
      originalUrl: 'https://example.invalid/policy',
      sourceVersion: 2,
      permissionRevision: 3,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function fixture(overrides: Partial<S7CitationReaderRecord> = {}) {
  const secret = '0123456789abcdef0123456789abcdef';
  const signer = new S7CitationSigner(secret);
  const item = candidate();
  const quoteText = item.text.slice(item.citationRange.start, item.citationRange.end);
  const record: S7CitationReaderRecord = {
    citationId: signer.issue(workspaceId),
    searchRequestId: 'search_test',
    knowledgeSpaceId: spaceId,
    segmentId,
    sourceId,
    title: item.source.name,
    sourceUrl: item.source.originalUrl,
    segmentRange: item.citationRange,
    score: 0.8,
    snapshotHash: citationSnapshotHash({
      workspaceId,
      sourceId,
      segmentId,
      segmentVersion: item.segment.version,
      title: item.source.name,
      sourceUrl: item.source.originalUrl,
      quoteText,
    }),
    expiresAt: new Date('2026-10-28T00:00:00Z'),
    ...overrides,
  };
  let reads = 0;
  const application = new S7CitationApplication({
    access: {
      assertSearchScope(ctx) {
        expect(ctx.scopes).toContain('knowledge:search');
      },
      async getAuthorizedSpace() {
        throw new Error('not used');
      },
    },
    authorizations: {
      async hydrate() {
        return { items: [], rejected: 0 };
      },
      async reauthorizeCitation() {
        return item;
      },
    },
    citations: {
      async issueWithAudit() {
        return new Map();
      },
      async findCurrent() {
        reads += 1;
        return record;
      },
    },
    signer,
    now: () => new Date('2026-10-27T12:00:00Z'),
  });
  return { application, signer, record, reads: () => reads };
}

describe('TEST-SEARCH-009-BLOCK citation lifecycle', () => {
  it('returns a valid citation without writing audit or citation state', async () => {
    const { application, record, reads } = fixture();
    const result = await application.get(record.citationId, context);
    expect(result.segmentId).toBe(segmentId);
    expect(reads()).toBe(1);
  });

  it('rejects expired, tampered and revoked citations as not found', async () => {
    const expired = fixture({ expiresAt: new Date('2026-10-27T11:00:00Z') });
    await expect(expired.application.get(expired.record.citationId, context)).rejects.toMatchObject(
      {
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      },
    );

    const tampered = fixture();
    await expect(
      tampered.application.get(`${tampered.record.citationId}x`, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    const revoked = fixture();
    revoked.application = new S7CitationApplication({
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
          return revoked.record;
        },
      },
      signer: revoked.signer,
      now: () => new Date('2026-10-27T12:00:00Z'),
    });
    await expect(revoked.application.get(revoked.record.citationId, context)).rejects.toMatchObject(
      {
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      },
    );
  });
});
