import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const corpus = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'b11-b', 'corpus.json'),
    'utf8',
  ),
) as Record<string, string>;

const context: TenantContext = {
  workspaceId: 'ws-b11-b-preview-segment',
  memberId: 'member-b11-b-preview-segment',
  requestId: 'req-b11-b-preview-segment',
  traceId: 'trace-b11-b-preview-segment',
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
  pages: [{ pageNumber: 1, text: corpus.mixedMarkdown!, assets: [] }],
  assets: [],
  diagnostics: [],
  evidence: {
    parserName: 'text',
    parserVersion: 'native-text@1',
    providerConfigHash: 'config-hash',
    rawTextHash: 'sha256:raw-hash',
  },
};

class FallbackQa implements S5QaPipelinePort {
  calls = 0;

  async generate(request: { chunk: ChunkItem }) {
    this.calls += 1;
    return {
      items: [
        {
          q: request.chunk.text,
          a: '',
          sourceChunkHash: request.chunk.contentHash,
        },
      ],
      fallback: 'chunk_split' as const,
      promptVersion: 'qa.default@1',
      usage: { inputTokens: 10, outputTokens: 2 },
      diagnostics: [{ severity: 'warning' as const, code: 'qa_output_invalid' }],
    };
  }

  dedupe(items: readonly S5QaResultItem[]): S5QaResultItem[] {
    return [...items];
  }
}

const settings: ChunkingSettings = {
  trainingType: 'chunk',
  chunkSettingMode: 'custom',
  chunkSplitMode: 'size',
  chunkSize: 192,
  chunkTriggerMinSize: 100,
};

describe('L1-B11-B PARSE-003/004 preview and final handoff', () => {
  it('L1-B11-B-PARSE-003-S01 produces identical chunks and hashes for repeated preview/process calls', () => {
    const application = new S5ProcessingApplication();
    const preview = application.processChunks({
      rawText: corpus.mixedMarkdown!,
      settings,
      context,
    });
    const processed = application.processChunks({
      rawText: corpus.mixedMarkdown!,
      settings,
      context,
    });
    expect(processed).toEqual(preview);
    expect(preview.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preview.chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect(preview.chunks.map((chunk) => chunk.index)).toEqual(
      preview.chunks.map((_, index) => index),
    );
  });

  it('L1-B11-B-PARSE-004-S01 records raw-text fallback without fabricating QA', async () => {
    const qa = new FallbackQa();
    const application = new S5ProcessingApplication(qa);
    const result = await application.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
      sourceName: 'B11-B corpus',
      sourceVersion: 1,
      rawText: corpus.mixedMarkdown!,
      artifact,
      settings: { ...settings, trainingType: 'qa', chunkSize: 1_000 },
      context,
    });
    expect(qa.calls).toBe(result.chunks.length);
    expect(result.evidence.fallbackUsed).toBe(true);
    expect(result.evidence.qaPromptVersion).toBe('qa.default@1');
    expect(result.qaItems).toHaveLength(result.chunks.length);
    expect(result.qaItems.every((item) => item.a === '')).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'qa_chunk_split_fallback' }),
    );
  });

  it('L1-B11-B-PARSE-003-N01 leaves existing preview content untouched for invalid settings', () => {
    const application = new S5ProcessingApplication();
    expect(() =>
      application.processChunks({
        rawText: corpus.mixedMarkdown!,
        settings: { ...settings, chunkSettingMode: 'invalid' as never },
        context,
      }),
    ).toThrow();
  });
});
