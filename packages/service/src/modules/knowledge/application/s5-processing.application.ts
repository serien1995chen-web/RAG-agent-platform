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
import type { S8ContentEnhancementApplication } from './s8-content-enhancement.application';

export interface S5QaChunkResult {
  items: S5QaResultItem[];
  fallback: 'none' | 'chunk_split';
  promptVersion: string | null;
  usage: { inputTokens: number; outputTokens: number };
  diagnostics: S5ParseDiagnostic[];
}

export interface S5QaPipelinePort {
  generate(input: {
    chunk: ChunkItem;
    settings: ChunkingSettings;
    context: TenantContext;
    workspaceId: string;
    knowledgeSpaceId: string;
    sourceId: string;
  }): Promise<S5QaChunkResult>;
  dedupe(items: readonly S5QaResultItem[]): S5QaResultItem[];
}

export interface S5ProcessingInput {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceName?: string;
  sourceVersion: number;
  rawText: string;
  artifact: S5ArtifactMaterializeResult;
  settings: ChunkingSettings;
  qaFallbackPolicy?: 'chunk_split' | 'none';
  ocrEvidence?: {
    actualProvider: string;
    fallbackProvider: string | null;
    fallbackUsed: boolean;
  };
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
  constructor(
    private readonly qa?: S5QaPipelinePort,
    private readonly enhancement?: S8ContentEnhancementApplication,
  ) {}

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
    input: Pick<
      S5ProcessingInput,
      'workspaceId' | 'knowledgeSpaceId' | 'sourceId' | 'settings' | 'qaFallbackPolicy' | 'context'
    > & { chunks: readonly ChunkItem[] },
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
        workspaceId: input.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        sourceId: input.sourceId,
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
      diagnostics.push(...result.diagnostics);
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
    const enhanced = this.enhancement
      ? await this.enhancement.enhanceParagraph(input)
      : {
          markdown: input.rawText,
          applied: false,
          promptVersion: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          diagnostics: [],
        };
    const prefix =
      input.settings.dataEnhanceCollectionName && input.sourceName ? `# ${input.sourceName}\n` : '';
    const chunks = this.processChunks({ ...input, rawText: enhanced.markdown });
    const effectiveChunks = prefix
      ? chunks.chunks.map((chunk) => {
          const text = `${prefix}${chunk.text}`;
          return {
            ...chunk,
            text,
            contentHash: configHashOf(text),
          };
        })
      : chunks.chunks;
    const qa = await this.generateQaForChunks({ ...input, chunks: effectiveChunks });
    const autoIndexes =
      input.settings.autoIndexes === true
        ? await this.generateQaForChunks({
            ...input,
            settings: { ...input.settings, trainingType: 'qa' },
            chunks: effectiveChunks,
          })
        : {
            items: [],
            fallbackUsed: false,
            promptVersion: null,
            diagnostics: [],
          };
    const autoItems = input.settings.indexPrefixTitle
      ? autoIndexes.items.map((item) => ({
          ...item,
          q: `# ${input.sourceName ?? 'Source'}\n${item.q}`,
          a: item.a,
        }))
      : autoIndexes.items;
    const imageIndex = input.settings.imageIndex
      ? await this.enhancement?.indexAssets({
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          assets: input.artifact.assets,
          orderOffset: effectiveChunks.length,
          context: input.context,
        })
      : undefined;
    return {
      sourceVersion: input.sourceVersion,
      rawText: enhanced.markdown,
      rawTextObjectRef: input.artifact.rawTextObjectRef,
      pages: input.artifact.pages,
      assets: input.artifact.assets,
      diagnostics: [
        ...input.artifact.diagnostics,
        ...enhanced.diagnostics,
        ...chunks.diagnostics,
        ...qa.diagnostics,
        ...autoIndexes.diagnostics,
        ...(imageIndex?.diagnostics ?? []),
      ],
      chunks: effectiveChunks,
      qaItems: this.qa ? this.qa.dedupe([...qa.items, ...autoItems]) : [...qa.items, ...autoItems],
      evidence: {
        ...input.artifact.evidence,
        ocrProvider: input.ocrEvidence?.actualProvider ?? null,
        ocrFallbackProvider: input.ocrEvidence?.fallbackUsed
          ? (input.ocrEvidence.fallbackProvider ?? null)
          : null,
        chunkingConfigHash: chunks.policyHash,
        qaPromptVersion: qa.promptVersion,
        fallbackUsed:
          qa.fallbackUsed || autoIndexes.fallbackUsed || (input.ocrEvidence?.fallbackUsed ?? false),
        paragraphEnhancementApplied: enhanced.applied,
        paragraphPromptVersion: enhanced.promptVersion,
        autoIndexPromptVersion: autoIndexes.promptVersion,
        autoIndexCount: autoItems.length,
        imageIndexCount: imageIndex?.segmentIds.length ?? 0,
        enhancementDiagnostics: [
          ...enhanced.diagnostics,
          ...autoIndexes.diagnostics,
          ...(imageIndex?.diagnostics ?? []),
        ],
        partial: imageIndex?.partial ?? false,
      },
    };
  }
}
