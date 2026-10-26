import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  OcrProviderPort,
  S5OcrAssetSinkPort,
  S5OcrProviderConfig,
  S5OcrProviderError,
  S5OcrProviderResult,
  S5OcrSourceGuardPort,
  S5ProviderUsage,
  S5ProviderUsageFact,
  S5ProviderUsageRecorderPort,
  S5RemoteAssetPort,
} from './s5-ocr-ports';
import { S5OcrProviderError as ProviderError } from './s5-ocr-ports';
import type { S5ParseAsset, S5ParseDiagnostic, S5ParsePage } from './s5-processing-ports';

export interface S5OcrFallbackResult {
  markdown: string;
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  diagnostics: S5ParseDiagnostic[];
}

export interface S5OcrApplicationInput {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion: number;
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  config: S5OcrProviderConfig;
  timeoutMs: number;
  requestId: string;
  traceId: string;
  context: TenantContext;
}

export interface S5OcrApplicationResult extends S5OcrProviderResult {
  fallbackUsed: boolean;
  actualProvider: string;
  attempts: number;
}

const IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;

function failureCode(kind: S5OcrProviderError['kind']) {
  if (kind === 'auth' || kind === 'provider') return 'KNOWLEDGE_MODEL_FAILED' as const;
  if (kind === 'rate_limit') return 'KNOWLEDGE_RATE_LIMITED' as const;
  if (kind === 'timeout') return 'KNOWLEDGE_DEPENDENCY_TIMEOUT' as const;
  if (kind === 'contract') return 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' as const;
  return 'KNOWLEDGE_QUOTA_EXCEEDED' as const;
}

function failureError(
  error: S5OcrProviderError,
  input: S5OcrApplicationInput,
  details: Record<string, unknown> = {},
) {
  return createKnowledgeError({
    code: failureCode(error.kind),
    requestId: input.requestId,
    traceId: input.traceId,
    retryable: error.kind === 'auth' ? false : error.retryable,
    details: {
      provider: input.config.provider,
      errorKind: error.kind,
      status: error.status,
      ...details,
    },
  });
}

function imageMatches(markdown: string): Array<{ alt: string; url: string; raw: string }> {
  const matches: Array<{ alt: string; url: string; raw: string }> = [];
  IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_RE.exec(markdown)) !== null) {
    matches.push({ alt: match[1] ?? '', url: match[2] ?? '', raw: match[0] });
  }
  return matches;
}

export class S5OcrApplication {
  constructor(
    private readonly input: {
      provider: OcrProviderPort;
      usage: S5ProviderUsageRecorderPort;
      remoteAssets: S5RemoteAssetPort;
      assetSink: S5OcrAssetSinkPort;
      sourceGuard: S5OcrSourceGuardPort;
      fallbackPdf?: (request: S5OcrApplicationInput) => Promise<S5OcrFallbackResult>;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private async recordUsage(
    input: S5OcrApplicationInput,
    usage: readonly S5ProviderUsage[],
    attempt: number,
    sequenceStart: number,
    fallbackUsed: boolean,
  ): Promise<number> {
    let sequence = sequenceStart;
    for (const entry of usage) {
      sequence += 1;
      const fact: S5ProviderUsageFact = {
        workspaceId: input.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        provider: entry.provider,
        unit: entry.unit,
        quantity: Math.max(0, entry.quantity),
        status: entry.status,
        attempt,
        eventSequence: sequence,
        requestId: input.requestId,
        traceId: input.traceId,
        fallbackUsed,
      };
      await this.input.usage.recordProviderUsage(fact, input.context);
    }
    return sequence;
  }

  private isPdf(input: S5OcrApplicationInput): boolean {
    return (
      input.mimeType.toLowerCase() === 'application/pdf' ||
      input.fileName.toLowerCase().endsWith('.pdf')
    );
  }

  private async fallback(
    input: S5OcrApplicationInput,
    sequence: number,
    attempt: number,
  ): Promise<S5OcrApplicationResult> {
    if (
      input.config.fallbackProvider !== 'liteparse' ||
      !this.isPdf(input) ||
      !this.input.fallbackPdf
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_FAILED',
        requestId: input.requestId,
        traceId: input.traceId,
        retryable: false,
        details: {
          provider: input.config.provider,
          reason: 'fallback_unavailable_or_not_pdf',
        },
      });
    }
    const result = await this.input.fallbackPdf(input);
    await this.recordUsage(
      input,
      [
        {
          provider: 'liteparse',
          unit: 'page',
          quantity: Math.max(1, result.pages.length),
          status: 200,
        },
      ],
      attempt,
      sequence,
      true,
    );
    return {
      markdown: result.markdown,
      pages: result.pages,
      assets: result.assets,
      diagnostics: [...result.diagnostics, { severity: 'warning', code: 'ocr_fallback_liteparse' }],
      usage: [],
      requestEvidence: {
        provider: input.config.provider,
        fallbackProvider: 'liteparse',
        fallbackUsed: true,
      },
      fallbackUsed: true,
      actualProvider: 'liteparse',
      attempts: attempt,
    };
  }

  private async transferImages(
    input: S5OcrApplicationInput,
    result: S5OcrProviderResult,
  ): Promise<S5OcrProviderResult> {
    const matches = imageMatches(result.markdown);
    if (matches.length === 0) return result;
    const replacement = new Map<string, string>();
    const materializedAssets: S5ParseAsset[] = [...result.assets];
    const diagnostics: S5ParseDiagnostic[] = [...result.diagnostics];
    for (const match of matches) {
      if (replacement.has(match.url)) continue;
      if (input.config.imageHandling === 'keep_url') {
        replacement.set(match.url, match.raw);
        diagnostics.push({ severity: 'warning', code: 'ocr_image_url_kept_unverified' });
        continue;
      }
      if (input.config.imageHandling === 'drop') {
        replacement.set(match.url, '');
        diagnostics.push({ severity: 'info', code: 'ocr_image_dropped' });
        continue;
      }
      const remote = await this.input.remoteAssets.fetch(match.url);
      const stored = await this.input.assetSink.putImage(
        {
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          bytes: remote.bytes,
          mimeType: remote.mimeType,
          sha256: remote.sha256,
        },
        input.context,
      );
      replacement.set(match.url, `![${match.alt}](${stored.markdownUrl})`);
      const existing = materializedAssets.find((asset) => asset.sourceUrl === match.url);
      if (existing) {
        existing.objectRefId = stored.objectRefId;
        existing.sha256 = remote.sha256;
        existing.sizeBytes = remote.bytes.byteLength;
        existing.mimeType = remote.mimeType;
      } else {
        materializedAssets.push({
          assetId: `remote-${remote.sha256.slice(0, 16)}`,
          mimeType: remote.mimeType,
          sha256: remote.sha256,
          sizeBytes: remote.bytes.byteLength,
          objectRefId: stored.objectRefId,
          sourceUrl: match.url,
        });
      }
    }
    const rewrite = (markdown: string) =>
      markdown.replace(IMAGE_RE, (raw, _alt, url) => replacement.get(url) ?? raw);
    return {
      ...result,
      markdown: rewrite(result.markdown),
      pages: result.pages.map((page) => ({ ...page, text: rewrite(page.text) })),
      assets: materializedAssets.map(({ bytes: _bytes, ...asset }) => asset),
      diagnostics,
    };
  }

  async parse(input: S5OcrApplicationInput): Promise<S5OcrApplicationResult> {
    if (input.context.workspaceId !== input.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { field: 'workspaceId' },
      });
    }
    await this.input.sourceGuard.assertSource(
      {
        workspaceId: input.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
      },
      input.context,
    );
    let sequence = 0;
    let schemaRetries = 0;
    let lastError: ProviderError | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.input.provider.parse(
          {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
            bytes: input.bytes,
            fileName: input.fileName,
            mimeType: input.mimeType,
            config: input.config,
            timeoutMs: input.timeoutMs,
            requestId: input.requestId,
            traceId: input.traceId,
          },
          input.context,
        );
        sequence = await this.recordUsage(input, result.usage, attempt, sequence, false);
        return {
          ...(await this.transferImages(input, result)),
          fallbackUsed: false,
          actualProvider: input.config.provider,
          attempts: attempt,
        };
      } catch (caught) {
        if (!(caught instanceof ProviderError)) throw caught;
        lastError = caught;
        sequence = await this.recordUsage(input, caught.usage, attempt, sequence, false);
        if (caught.kind === 'auth') throw failureError(caught, input);
        const canSchemaRetry =
          caught.kind === 'contract' && caught.schemaRetryable && schemaRetries < 1;
        if (canSchemaRetry) {
          schemaRetries += 1;
          continue;
        }
        if (caught.retryable && attempt < 3) {
          await (this.input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            Math.min(5_000, 250 * 2 ** (attempt - 1)),
          );
          continue;
        }
        if (input.config.fallbackProvider === 'liteparse') {
          try {
            return await this.fallback(input, sequence, attempt);
          } catch {
            throw failureError(caught, input, { fallbackFailed: true });
          }
        }
        throw failureError(caught, input);
      }
    }
    if (lastError && input.config.fallbackProvider === 'liteparse') {
      return this.fallback(input, sequence, 3);
    }
    throw lastError
      ? failureError(lastError, input)
      : createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: input.requestId,
          traceId: input.traceId,
          details: { reason: 'ocr_attempts_exhausted_without_result' },
        });
  }
}
