import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { ChunkItem } from '@kb/chunk';

export interface S5QaResultItem {
  q: string;
  a: string;
  sourceChunkHash: string;
}

export interface S5ObjectArtifactRef {
  blobId: string;
  objectKey: string;
  purpose: 'source' | 'image';
  sha256: string;
  sizeBytes: number;
}

export interface S5ParseAsset {
  assetId: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  objectRefId?: string;
  sourceUrl?: string;
  bytes?: Uint8Array;
}

export interface S5ParsePage {
  pageNumber: number;
  text: string;
  assets: S5ParseAsset[];
}

export interface S5ParseDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  path?: string;
  page?: number;
  count?: number;
}

export interface S5ParseResult {
  format: string;
  rawText: string;
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  diagnostics: S5ParseDiagnostic[];
  scanRequired: boolean;
  imageRefs: string[];
  contentHash: string;
  parserVersion: string;
  configHash: string;
}

export interface S5ProcessingResult {
  sourceVersion: number;
  rawText: string;
  rawTextObjectRef: S5ObjectArtifactRef;
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  diagnostics: S5ParseDiagnostic[];
  chunks: ChunkItem[];
  qaItems: S5QaResultItem[];
  evidence: {
    parserName: string;
    parserVersion: string;
    providerConfigHash: string;
    rawTextHash: string;
    ocrProvider: string | null;
    ocrFallbackProvider: string | null;
    chunkingConfigHash: string;
    qaPromptVersion: string | null;
    fallbackUsed: boolean;
    paragraphEnhancementApplied?: boolean;
    paragraphPromptVersion?: string | null;
    autoIndexPromptVersion?: string | null;
    autoIndexCount?: number;
    imageIndexCount?: number;
    enhancementDiagnostics?: S5ParseDiagnostic[];
    partial?: boolean;
  };
}

export interface S5ArtifactPutInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  purpose: 'source' | 'image';
  sha256: string;
}

export interface S5ArtifactPutResult {
  key: string;
  size: number;
  etag: string;
  sha256: string;
}

export interface S5ArtifactStorePort {
  readonly provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
  readonly bucket: string;
  putObject(input: S5ArtifactPutInput, context: TenantContext): Promise<S5ArtifactPutResult>;
}

export interface S5ArtifactMaterializeInput {
  sourceId: string;
  sourceVersion: number;
  knowledgeSpaceId: string;
  parse: S5ParseResult;
}

export interface S5ArtifactMaterializeResult {
  sourceVersion: number;
  rawTextObjectRef: S5ObjectArtifactRef;
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  diagnostics: S5ParseDiagnostic[];
  evidence: Pick<
    S5ProcessingResult['evidence'],
    'parserName' | 'parserVersion' | 'providerConfigHash' | 'rawTextHash'
  >;
}

export function parseIdempotencyKeyOf(input: {
  sourceId: string;
  sourceVersion: number;
  parseProvider: string;
  configHash: string;
}): string {
  return [input.sourceId, input.sourceVersion, input.parseProvider, input.configHash].join(':');
}
