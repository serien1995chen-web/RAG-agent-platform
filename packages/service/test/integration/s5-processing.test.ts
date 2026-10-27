import { describe, expect, it } from 'vitest';
import type { ChunkItem, ChunkingSettings } from '@kb/chunk';
import {
  S5ProcessingApplication,
  type S5QaPipelinePort,
} from '../../src/modules/knowledge/application/s5-processing.application';
import type {
  S5ArtifactMaterializeResult,
  S5QaResultItem,
} from '../../src/modules/knowledge/application/s5-processing-ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_processing',
  memberId: 'mem_processing',
  requestId: 'req-processing',
  traceId: 'trace-processing',
  scopes: ['knowledge:write'],
};

const artifact: S5ArtifactMaterializeResult = {
  sourceVersion: 1,
  rawTextObjectRef: {
    blobId: '65f1e5b2a1c9d4b7e8f00001',
    objectKey: 'workspace/ws/source/raw.md',
    purpose: 'source',
    sha256: 'raw-hash',
    sizeBytes: 100,
  },
  pages: [{ pageNumber: 1, text: 'source text', assets: [] }],
  assets: [],
  diagnostics: [],
  evidence: {
    parserName: 'text',
    parserVersion: 'native-text@1',
    providerConfigHash: 'config-hash',
    rawTextHash: 'sha256:raw-hash',
  },
};

class FakeQa implements S5QaPipelinePort {
  readonly calls: ChunkItem[] = [];

  constructor(
    private readonly result: (input: ChunkItem) => {
      items: S5QaResultItem[];
      fallback: 'none' | 'chunk_split';
    } = () => ({
      items: [],
      fallback: 'none',
    }),
  ) {}

  async generate(input: { chunk: ChunkItem }) {
    this.calls.push(input.chunk);
    const result = this.result(input.chunk);
    return {
      ...result,
      promptVersion: 'qa.default@1',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  dedupe(items: readonly S5QaResultItem[]): S5QaResultItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.q}\0${item.a}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

const baseSettings: ChunkingSettings = {
  trainingType: 'chunk',
  chunkSettingMode: 'custom',
  chunkSplitMode: 'char',
  chunkSize: 500,
};

describe('TEST-PARSE-003/004-BLOCK S5 processing application', () => {
  it('chunks deterministically and never invokes QA for trainingType=chunk', async () => {
    const qa = new FakeQa();
    const application = new S5ProcessingApplication(qa);
    const result = await application.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-processing',
      sourceId: 'source-processing',
      sourceVersion: 1,
      rawText: '知识库切分文本。'.repeat(20),
      artifact,
      settings: baseSettings,
      context,
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.qaItems).toEqual([]);
    expect(qa.calls).toHaveLength(0);
    expect(result.rawTextObjectRef.purpose).toBe('source');
    expect(result.evidence.chunkingConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('calls QA per chunk, dedupes globally and records prompt/fallback evidence', async () => {
    const qa = new FakeQa((input) => ({
      items: [
        { q: 'same', a: 'answer', sourceChunkHash: input.contentHash },
        { q: `question-${input.index}`, a: 'answer', sourceChunkHash: input.contentHash },
      ],
      fallback: input.index === 0 ? 'chunk_split' : 'none',
    }));
    const application = new S5ProcessingApplication(qa);
    const result = await application.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-processing',
      sourceId: 'source-processing',
      sourceVersion: 1,
      rawText: 'First paragraph.\n\nSecond paragraph.',
      artifact,
      settings: { ...baseSettings, trainingType: 'qa', chunkSize: 64 },
      context,
    });
    expect(qa.calls.length).toBe(result.chunks.length);
    expect(result.qaItems.filter((item) => item.q === 'same')).toHaveLength(1);
    expect(result.evidence.qaPromptVersion).toBe('qa.default@1');
    expect(result.evidence.fallbackUsed).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'qa_chunk_split_fallback' }),
    );
  });

  it('returns empty chunks for empty text without creating fake QA', async () => {
    const qa = new FakeQa();
    const application = new S5ProcessingApplication(qa);
    const result = await application.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-processing',
      sourceId: 'source-processing',
      sourceVersion: 1,
      rawText: '   ',
      artifact,
      settings: { ...baseSettings, trainingType: 'qa' },
      context,
    });
    expect(result.chunks).toEqual([]);
    expect(result.qaItems).toEqual([]);
    expect(qa.calls).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'empty_raw_text_no_chunks' }),
    );
  });

  it('maps unknown settings to 400 and fallbackPolicy=none to 502', async () => {
    const application = new S5ProcessingApplication(
      new FakeQa(() => ({ items: [], fallback: 'chunk_split' })),
    );
    await expect(
      application.process({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-processing',
        sourceId: 'source-processing',
        sourceVersion: 1,
        rawText: 'text',
        artifact,
        settings: { ...baseSettings, chunkSettingMode: 'unknown' as never },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      application.process({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-processing',
        sourceId: 'source-processing',
        sourceVersion: 1,
        rawText: 'text',
        artifact,
        settings: { ...baseSettings, trainingType: 'qa' },
        qaFallbackPolicy: 'none',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
  });
});
