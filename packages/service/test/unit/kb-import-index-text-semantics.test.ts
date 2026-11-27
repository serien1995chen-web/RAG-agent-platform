import { describe, expect, it, vi } from 'vitest';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-import-index-title',
  memberId: 'mem-import-index-title',
  requestId: 'req-import-index-title',
  traceId: 'trace-import-index-title',
  scopes: ['knowledge:write'],
};

describe('FastGPT index-title indexing semantics', () => {
  it('adds the source title to embedding input without enabling supplemental indexes', async () => {
    const embeddedTexts: string[][] = [];
    const switchedIndexTexts: string[] = [];
    const segment = {
      id: '65f1e5b2a1c9d4b7e8f20001',
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f20002',
      sourceId: '65f1e5b2a1c9d4b7e8f20003',
      sourceVersion: 1,
      searchEnabled: true,
      order: 0,
      question: '正文内容',
      answer: '正文内容',
      content: '正文内容',
      fullTextTokens: '正文内容',
      fullTextVersion: 1,
      metadata: {},
      history: [],
      indexes: [],
      indexStatus: 'indexing' as const,
      indexErrorCode: null,
      version: 1,
    };
    const job = {
      _id: { toString: () => '65f1e5b2a1c9d4b7e8f20004' },
      resourceId: segment.id,
      resourceType: 'segment',
      inputSnapshot: {
        operation: 'index',
        indexPrefixTitle: true,
        sourceName: '导入验收来源',
      },
    };
    const application = new S06ProcessingApplication({
      jobs: {
        setStep: vi.fn(async () => undefined),
      },
      store: {
        getSegment: vi.fn(async () => segment),
        listSegmentsBySource: vi.fn(async () => [{ ...segment, indexStatus: 'indexed' }]),
        switchSegmentIndex: vi.fn(async (input: { indexes: Array<{ text?: string }> }) => {
          switchedIndexTexts.push(input.indexes[0]?.text ?? '');
          return {
            ...segment,
            indexStatus: 'indexed',
          };
        }),
        updateSourceStatus: vi.fn(async () => undefined),
      },
      artifacts: {},
      processing: {},
      vectors: {
        insert: vi.fn(async () => ({
          inserted: 1,
          vectorIds: ['65f1e5b2a1c9d4b7e8f20005'],
        })),
        listProfiles: vi.fn(() => [
          { tableName: 'knowledge_vectors_768', storageType: 'vector' as const, dimension: 768 },
        ]),
      },
      fulltext: {
        project: vi.fn(async () => ({
          fullTextVersion: 2,
          segmentVersion: 2,
          tokenizerVersion: 'test',
          tokensHash: 'hash',
        })),
      },
      models: {
        listModels: vi.fn(async () => [
          {
            modelId: 'embedding-768',
            displayName: 'Embedding',
            type: 'embedding' as const,
            capabilities: ['text-embedding'],
            dimension: 768,
            authorized: true,
          },
        ]),
      },
      bindings: {
        list: vi.fn(async () => [
          {
            modelType: 'embedding' as const,
            modelId: 'embedding-768',
            displayName: 'Embedding',
            requiredCapabilities: ['text-embedding'],
            status: 'active' as const,
          },
        ]),
      },
      port: {
        embed: vi.fn(async (input: { texts: string[] }) => {
          embeddedTexts.push(input.texts);
          return [[0.1]];
        }),
      },
    } as never);

    await (
      application as unknown as {
        processIndex(job: unknown, context: TenantContext): Promise<unknown>;
      }
    ).processIndex(job, context);

    expect(embeddedTexts).toEqual([['# 导入验收来源\n正文内容']]);
    expect(switchedIndexTexts).toEqual(['正文内容']);
  });
});
