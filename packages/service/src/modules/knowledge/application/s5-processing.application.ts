import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { chunkText, toChunkPolicy, type ChunkItem, type ChunkingSettings } from '@kb/chunk';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  S5ArtifactMaterializeResult,
  S5ParseDiagnostic,
  S5ProcessingResult,
  S5QaResultItem,
} from './s5-processing-ports';

export interface S5QaChunkResult {
  items: S5QaResultItem[];
  fallback: 'none' | 'chunk_split';
  promptVersion: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface S5QaPipelinePort {
  generate(input: {
    chunk: ChunkItem;
    settings: ChunkingSettings;
    context: TenantContext;
  }): Promise<S5QaChunkResult>;
  dedupe(items: readonly S5QaResultItem[]): S5QaResultItem[];
}

export interface S5ProcessingInput {
  sourceVersion: number;
  rawText: string;
  artifact: S5ArtifactMaterializeResult;
  settings: ChunkingSettings;
  qaFallbackPolicy?: 'chunk_split' | 'none';
  context: TenantContext;
}

function validationError(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function configHashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export class S5ProcessingApplication {
  constructor(private readonly qa?: S5QaPipelinePort) {}

  processChunks(input: Pick<S5ProcessingInput, 'rawText' | 'settings' | 'context'>): {
    chunks: ChunkItem[];
    diagnostics: S5ParseDiagnostic[];
    policyHash: string;
  } {
    let policy;
    try {
      policy = toChunkPolicy(input.settings);
    } catch (error) {
      throw validationError(input.context, {
        field: 'chunkingSettings',
        reason: error instanceof Error ? error.message : 'invalid',
      });
    }
    if (input.rawText.trim().length === 0) {
      return {
        chunks: [],
        diagnostics: [{ severity: 'warning', code: 'empty_raw_text_no_chunks' }],
        policyHash: configHashOf(policy),
      };
    }
    let chunks: ChunkItem[];
    try {
      chunks = chunkText({ text: input.rawText, policy }).chunks;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'problem' in error) {
        throw error;
      }
      throw validationError(input.context, {
        field: 'chunkingSettings',
        reason: error instanceof Error ? error.message : 'chunking_failed',
      });
    }
    return {
      chunks,
      diagnostics: [],
      policyHash: configHashOf(policy),
    };
  }

  async generateQaForChunks(
    input: Pick<S5ProcessingInput, 'settings' | 'qaFallbackPolicy' | 'context'> & {
      chunks: readonly ChunkItem[];
    },
  ): Promise<{
    items: S5QaResultItem[];
    fallbackUsed: boolean;
    promptVersion: string | null;
    diagnostics: S5ParseDiagnostic[];
  }> {
    if (input.settings.trainingType !== 'qa') {
      return { items: [], fallbackUsed: false, promptVersion: null, diagnostics: [] };
    }
    if (!this.qa) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { reason: 'qa_pipeline_missing' },
      });
    }
    const items: S5QaResultItem[] = [];
    const diagnostics: S5ParseDiagnostic[] = [];
    const promptVersions = new Set<string>();
    let fallbackUsed = false;
    for (const chunk of input.chunks) {
      const result = await this.qa.generate({
        chunk,
        settings: input.settings,
        context: input.context,
      });
      if (result.fallback === 'chunk_split') {
        fallbackUsed = true;
        if ((input.qaFallbackPolicy ?? 'chunk_split') === 'none') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            retryable: false,
            details: { chunkHash: chunk.contentHash, fallbackPolicy: 'none' },
          });
        }
        diagnostics.push({
          severity: 'warning',
          code: 'qa_chunk_split_fallback',
        });
      }
      if (result.promptVersion) promptVersions.add(result.promptVersion);
      items.push(...result.items);
    }
    return {
      items: this.qa.dedupe(items),
      fallbackUsed,
      promptVersion:
        promptVersions.size === 0
          ? null
          : promptVersions.size === 1
            ? [...promptVersions][0]!
            : `mixed:${configHashOf([...promptVersions].sort())}`,
      diagnostics,
    };
  }

  async process(input: S5ProcessingInput): Promise<S5ProcessingResult> {
    const chunks = this.processChunks(input);
    const qa = await this.generateQaForChunks({ ...input, chunks: chunks.chunks });
    return {
      sourceVersion: input.sourceVersion,
      rawText: input.rawText,
      rawTextObjectRef: input.artifact.rawTextObjectRef,
      pages: input.artifact.pages,
      assets: input.artifact.assets,
      diagnostics: [...input.artifact.diagnostics, ...chunks.diagnostics, ...qa.diagnostics],
      chunks: chunks.chunks,
      qaItems: qa.items,
      evidence: {
        ...input.artifact.evidence,
        ocrProvider: null,
        ocrFallbackProvider: null,
        chunkingConfigHash: chunks.policyHash,
        qaPromptVersion: qa.promptVersion,
        fallbackUsed: qa.fallbackUsed,
      },
    };
  }
}
