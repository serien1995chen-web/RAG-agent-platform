import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S5ParseAsset, S5ParseDiagnostic, S5ParsePage } from './s5-processing-ports';

export type S5OcrProviderName = 'sangfor' | 'somark' | 'textin' | 'doc2x';
export type S5ImageHandling = 'upload_to_storage' | 'keep_url' | 'drop';

export interface S5OcrCommonConfig {
  credentialProfileId: string;
  timeoutMs: number;
  fallbackProvider: 'liteparse' | 'none';
  imageHandling: S5ImageHandling;
}

export type S5OcrProviderConfig =
  | (S5OcrCommonConfig & {
      provider: 'sangfor';
      allowedExtensions?: string[];
      keepHeaderFooter: boolean;
      keepAppendix: boolean;
      imageAnalysis: boolean;
      chartAnalysis: boolean;
    })
  | (S5OcrCommonConfig & { provider: 'somark' })
  | (S5OcrCommonConfig & {
      provider: 'textin';
      removeWatermark: boolean;
      parseMode: 'auto' | 'scan';
    })
  | (S5OcrCommonConfig & {
      provider: 'doc2x';
      pollIntervalMs: number;
    });

export interface S5OcrRequest {
  workspaceId: string;
  sourceId: string;
  sourceVersion: number;
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  config: S5OcrProviderConfig;
  timeoutMs: number;
  requestId: string;
  traceId: string;
}

export interface S5ProviderUsage {
  provider: string;
  unit: 'page' | 'image' | 'request';
  quantity: number;
  status: number | null;
}

export interface S5OcrProviderResult {
  markdown: string;
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  usage: S5ProviderUsage[];
  diagnostics: S5ParseDiagnostic[];
  requestEvidence: Record<string, unknown>;
}

export interface OcrProviderPort {
  parse(input: S5OcrRequest, context: TenantContext): Promise<S5OcrProviderResult>;
}

export interface OcrCredentialProfilePort {
  resolve(
    profileId: string,
    provider: S5OcrProviderName,
  ): Promise<{
    endpoint: string;
    credentials: Record<string, string>;
  }>;
}

export interface S5OcrHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array | FormData;
  timeoutMs: number;
  responseType?: 'json' | 'arraybuffer';
}

export interface S5OcrHttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  data: T;
}

export interface S5OcrHttpTransportPort {
  request<T = unknown>(input: S5OcrHttpRequest): Promise<S5OcrHttpResponse<T>>;
}

export interface S5RemoteAssetPort {
  fetch(url: string): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    sha256: string;
  }>;
}

export interface S5OcrAssetSinkPort {
  putImage(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      sourceId: string;
      sourceVersion: number;
      bytes: Uint8Array;
      mimeType: string;
      sha256: string;
    },
    context: TenantContext,
  ): Promise<{ objectRefId: string; markdownUrl: string }>;
}

export interface S5OcrSourceGuardPort {
  assertSource(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      sourceId: string;
      sourceVersion: number;
    },
    context: TenantContext,
  ): Promise<void>;
}

export interface S5ProviderUsageFact {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion: number;
  provider: string;
  unit: 'page' | 'image' | 'request';
  quantity: number;
  status: number | null;
  attempt: number;
  eventSequence: number;
  requestId: string;
  traceId: string;
  fallbackUsed: boolean;
}

export interface S5ProviderUsageRecorderPort {
  recordProviderUsage(fact: S5ProviderUsageFact, context: TenantContext): Promise<boolean>;
}

export type S5OcrFailureKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'provider'
  | 'contract'
  | 'quota';

export class S5OcrProviderError extends Error {
  constructor(
    readonly kind: S5OcrFailureKind,
    readonly status: number | null,
    readonly usage: S5ProviderUsage[],
    readonly retryable: boolean,
    readonly schemaRetryable: boolean,
  ) {
    super(`OCR provider failed: ${kind}`);
    this.name = 'S5OcrProviderError';
  }
}
