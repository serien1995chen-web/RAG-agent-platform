import { describe, expect, it, vi } from 'vitest';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-s8-enhance',
  memberId: 'mem-s8-enhance',
  requestId: 'req-s8-enhance',
  traceId: 'trace-s8-enhance',
  scopes: ['knowledge:write'],
};

const chunk = {
  index: 0,
  text: 'Refund policy',
  contentHash: 'sha256:refund',
};

describe('TEST-PARSE-005-BLOCK paragraph, auto index and document images', () => {
  it('reuses the S5 QA pipeline for derived indexes and preserves the base chunk', async () => {
    const generate = vi.fn(async () => ({
      items: [{ q: 'How long?', a: 'Five days.', sourceChunkHash: chunk.contentHash }],
      fallback: 'none' as const,
      promptVersion: 'qa.default@1',
      usage: { inputTokens: 2, outputTokens: 1 },
      diagnostics: [],
    }));
    const processing = new S5ProcessingApplication(
      {
        generate,
        dedupe: (items) => [...items],
      },
      {
        async enhanceParagraph(input) {
          return {
            markdown: input.rawText,
            applied: false,
            promptVersion: 's8.paragraph-enhance.v1',
            usage: { inputTokens: 0, outputTokens: 0 },
            diagnostics: [],
          };
        },
        async indexAssets() {
          return {
            segmentIds: ['65f1e5b2a1c9d4b7e8f22222'],
            diagnostics: [],
            partial: false,
          };
        },
      } as never,
    );
    const result = await processing.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      sourceId: '65f1e5b2a1c9d4b7e8f05678',
      sourceName: 'Support policy',
      sourceVersion: 1,
      rawText: 'Refund policy. Refunds are processed within five business days.',
      artifact: {
        sourceVersion: 1,
        rawTextObjectRef: {
          blobId: '65f1e5b2a1c9d4b7e8f09999',
          objectKey: 'hidden',
          purpose: 'source',
          sha256: 'sha256',
          sizeBytes: 10,
        },
        pages: [],
        assets: [],
        diagnostics: [],
        evidence: {
          parserName: 'fixture',
          parserVersion: '1',
          providerConfigHash: 'hash',
          rawTextHash: 'hash',
        },
      },
      settings: {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 800,
        paragraphChunkAIMode: 'forbid',
        autoIndexes: true,
        indexPrefixTitle: true,
        imageIndex: true,
      },
      context,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].settings.trainingType).toBe('qa');
    expect(result.qaItems).toEqual([
      expect.objectContaining({
        q: expect.stringContaining('# Support policy'),
        a: 'Five days.',
      }),
    ]);
    expect(result.evidence).toMatchObject({
      autoIndexCount: 1,
      imageIndexCount: 1,
      autoIndexPromptVersion: 'qa.default@1',
    });
  });
});
