import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeObjectProvider } from './ports';
import type { SynonymInputRow, SynonymMapping } from '../domain/s09-synonym';
import type {
  SynonymRebuildPlan,
  SynonymRebuildReason,
  SynonymRebuildResult,
  SynonymStagedRebuild,
} from '../domain/s09-synonym-rebuild';

export interface S09SynonymLastError {
  code: string;
  message: string;
  rowNumber?: number;
}

export interface S09SynonymConfigView {
  knowledgeSpaceId: string;
  fileName: string;
  sizeBytes: number;
  activeFileVersion: number;
  enabled: boolean;
  schemaVersion: 2;
  status: 'active' | 'disabled' | 'rebuilding' | 'failed';
  mappingCount: number;
  termCount: number;
  version: number;
  updatedAt: string;
  lastError: S09SynonymLastError | null;
}

export interface S09SynonymMappingView {
  logicalMappingId: string;
  fileVersion: number;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonymTerms: string[];
  normalizedSynonymTerms: string[];
  fingerprint: string;
}

export interface S09SynonymMappingPage {
  items: S09SynonymMappingView[];
  nextCursor: string | null;
  hasMore: boolean;
  fileVersion: number;
}

export interface S09SynonymJobView {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: 'synonym_rebuild';
  resourceType: 'synonym' | 'space';
  resourceId: string;
  inputSnapshot: Record<string, unknown>;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface S09StoredSynonymFile {
  blobId: string;
  provider: KnowledgeObjectProvider;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
  originalName: string;
}

export interface S09SynonymRawFilePort {
  store(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      fileName: string;
      mimeType: string;
      bytes: Uint8Array;
      sha256: string;
    },
    context: TenantContext,
  ): Promise<S09StoredSynonymFile>;
}

export interface S09SynonymFileParserPort {
  parse(input: { fileName: string; bytes: Uint8Array; requestId: string; traceId: string }): {
    format: 'csv' | 'xls' | 'xlsx';
    rows: SynonymInputRow[];
  };
}

export interface S09PublishedSynonymSnapshot {
  knowledgeSpaceId: string;
  fileVersion: number;
  mappings: SynonymMapping[];
}

export interface S09CreatePendingVersionInput {
  expectedFileVersion?: number;
  enabled: boolean;
  reason: SynonymRebuildReason;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  mappings: readonly SynonymMapping[];
  rawFile: S09StoredSynonymFile;
  sourceIds: readonly string[];
  idempotencyKey: string;
  requestHash: string;
}

export interface S09SynonymRepositoryPort {
  findByChecksum(
    spaceId: string,
    checksumSha256: string,
    context: TenantContext,
  ): Promise<number | null>;
  createPendingVersion(
    spaceId: string,
    input: S09CreatePendingVersionInput,
    context: TenantContext,
  ): Promise<{
    config: S09SynonymConfigView;
    job: S09SynonymJobView | null;
    replayed: boolean;
  }>;
  getConfig(spaceId: string, context: TenantContext): Promise<S09SynonymConfigView>;
  getPublishedSnapshot(
    spaceId: string,
    context: TenantContext,
  ): Promise<S09PublishedSynonymSnapshot | null>;
  assertPublishedVersion(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
  ): Promise<boolean>;
  getMappingSnapshot(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
  ): Promise<SynonymMapping[] | null>;
  listMappings(
    spaceId: string,
    input: {
      fileVersion?: number;
      cursor?: string;
      limit: number;
      search?: string;
    },
    context: TenantContext,
  ): Promise<S09SynonymMappingPage>;
  toggle(
    spaceId: string,
    input: { enabled: boolean; version: number },
    context: TenantContext,
  ): Promise<S09SynonymConfigView>;
  disableAndDelete(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<{ id: string; status: 'disabled'; jobId: null }>;
  listActiveSourceIds(spaceId: string, context: TenantContext): Promise<string[]>;
  createManualRebuild(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<S09SynonymJobView>;
  getRebuildPlan(jobId: string, context: TenantContext): Promise<SynonymRebuildPlan>;
  completeRebuild(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    result: SynonymRebuildResult,
    context: TenantContext,
  ): Promise<void>;
  failRebuild(
    plan: SynonymRebuildPlan,
    input: {
      retryable: boolean;
      errorCode: string;
      failureEvidence: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<void>;
}

export type S09QueryExpansionMapping = SynonymMapping;

export interface S09QueryExpansionSpace {
  spaceId: string;
  fileVersion: number;
  mappings: S09QueryExpansionMapping[];
}

export interface S09QueryExpansionHit {
  knowledgeSpaceId: string;
  fileVersion: number;
  logicalMappingId: string;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  matchedTerm: string;
  start: number;
  end: number;
}

export interface S09QueryExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  hits: S09QueryExpansionHit[];
  normalizedStandardTerms: string[];
  appliedMappingIds: string[];
  fallbackReason:
    | 'disabled'
    | 'version_changed'
    | 'cache_mismatch'
    | 'safety'
    | 'code_point_limit'
    | null;
}

export type S09MergeExpansions = (input: {
  queries: readonly string[];
  contexts: ReadonlyArray<{
    knowledgeSpaceId: string;
    fileVersion: number;
    mappings: ReadonlyArray<{
      logicalMappingId: string;
      standardizedTerm: string;
      normalizedStandardizedTerm: string;
      synonymTerms: readonly string[];
      normalizedSynonymTerms: readonly string[];
    }>;
  }>;
}) => S09QueryExpansionResult[];

export interface S09QueryExpansionPort {
  expand(
    input: {
      query: string;
      spaceIds: readonly string[];
    },
    context: TenantContext,
  ): Promise<{
    result: S09QueryExpansionResult;
    auditSummary: {
      spaces: Array<{
        knowledgeSpaceId: string;
        fileVersion: number;
        mappingIds: string[];
      }>;
      cacheHits: number;
      cacheMisses: number;
      fallbackReason: S09QueryExpansionResult['fallbackReason'];
    };
  }>;
}

export interface S09S6RebuildIndexPort {
  stage(input: { plan: SynonymRebuildPlan; context: TenantContext }): Promise<SynonymStagedRebuild>;
  reuseOrBuildVector(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
  }): Promise<SynonymStagedRebuild>;
  finalize(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
  }): Promise<{
    indexedSegmentVersions: Record<string, number>;
    cleanupCandidates: SynonymStagedRebuild['cleanupCandidates'];
  }>;
  rollback(input: { stagingId: string; context: TenantContext }): Promise<void>;
}

export interface S09S6RebuildPort {
  stageProfile(plan: SynonymRebuildPlan, context: TenantContext): Promise<SynonymStagedRebuild>;
  reuseOrBuildVector(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild>;
  finalize(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild>;
  rollback(stagingId: string, context: TenantContext): Promise<void>;
}
