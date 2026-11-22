import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CitationApiSchema } from '../../packages/contracts/src/index';

const root = resolve(import.meta.dirname, '../..');
const knowledgeSpaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f10001';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';

const citation = {
  citationId: 'cit_01234567-89ab-4cde-8fab-0123456789ab.signature',
  segmentId,
  sourceId,
  knowledgeSpaceId,
  title: 'Refund policy',
  sourceUrl: 'https://example.invalid/refund-policy',
  segmentRange: { start: 0, end: 43 },
  score: 0.91,
  version: 4,
  quoteText: 'Refunds are processed within five business days.',
  snapshotHash: 'a'.repeat(64),
  expiresAt: '2026-11-23T09:13:23.000Z',
};

describe('B18-A SEARCH-009 Citation public contract', () => {
  it('L1-B18-SEARCH-009-P01 exposes Space, quote snapshot, hash and expiry to direct consumers', () => {
    const parsed = CitationApiSchema.safeParse(citation);
    if (!parsed.success) {
      throw new Error(
        `Citation contract rejected required B18 fields: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.data).toMatchObject({
      knowledgeSpaceId,
      quoteText: citation.quoteText,
      snapshotHash: citation.snapshotHash,
      expiresAt: citation.expiresAt,
    });
  });

  it('L1-B18-SEARCH-009-Q01 publishes the same required fields in OpenAPI', () => {
    const openapi = JSON.parse(
      readFileSync(
        resolve(root, 'packages/contracts/openapi/knowledge-target.openapi.json'),
        'utf8',
      ),
    ) as {
      components: {
        schemas: {
          Citation: {
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
    };
    const schema = openapi.components.schemas.Citation;
    expect(schema.required).toEqual(
      expect.arrayContaining(['knowledgeSpaceId', 'quoteText', 'snapshotHash', 'expiresAt']),
    );
    expect(schema.properties).toMatchObject({
      knowledgeSpaceId: expect.any(Object),
      quoteText: expect.any(Object),
      snapshotHash: expect.any(Object),
      expiresAt: expect.any(Object),
    });
  });
});
