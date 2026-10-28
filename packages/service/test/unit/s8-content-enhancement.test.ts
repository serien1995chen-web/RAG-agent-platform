import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '@kb/contracts';
import { S8ContentEnhancementApplication } from '../../src/modules/knowledge/application/s8-content-enhancement.application';
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

  it('marks auto-index fallback and image diagnostics as partial evidence', async () => {
    const processing = new S5ProcessingApplication(
      {
        generate: async () => ({
          items: [{ q: 'Fallback?', a: 'Safe.', sourceChunkHash: chunk.contentHash }],
          fallback: 'chunk_split' as const,
          promptVersion: 'qa.default@1',
          usage: { inputTokens: 1, outputTokens: 1 },
          diagnostics: [{ severity: 'warning' as const, code: 'qa_output_invalid' }],
        }),
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
            diagnostics: [
              { severity: 'warning' as const, code: 'image_asset_index_failed', path: 'asset-1' },
            ],
            partial: true,
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
      rawText: 'Refund policy',
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
        chunkSettingMode: 'auto',
        autoIndexes: true,
        imageIndex: true,
      },
      context,
    });
    expect(result.evidence).toMatchObject({
      partial: true,
      fallbackUsed: true,
    });
    expect(result.evidence.enhancementDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'qa_output_invalid' }),
        expect.objectContaining({ code: 'image_asset_index_failed' }),
      ]),
    );
  });

  it('returns 422 instead of partial when both vision model paths are unavailable', async () => {
    const enhancement = new S8ContentEnhancementApplication({
      gateway: {
        async invoke() {
          throw new Error('not used');
        },
      },
      models: {
        resolveVlm: async () => {
          throw new Error('not used');
        },
        resolveVisionEmbedding: async () => {
          throw new Error('not used');
        },
        resolveLlm: async () => {
          throw new Error('not used');
        },
      },
      caption: {
        async processAsset() {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: {
              reason: 'vision_models_unavailable',
              fields: ['modelBindings.vlm', 'modelBindings.visionEmbedding'],
            },
          });
        },
      } as never,
    });
    await expect(
      enhancement.indexAssets({
        sourceId: '65f1e5b2a1c9d4b7e8f05678',
        sourceVersion: 1,
        assets: [
          {
            assetId: 'asset-1',
            mimeType: 'image/png',
            sha256: 'sha256',
            sizeBytes: 128,
            objectRefId: '65f1e5b2a1c9d4b7e8f09999',
          },
        ],
        orderOffset: 0,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });
});
