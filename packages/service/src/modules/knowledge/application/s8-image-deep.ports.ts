import type { CitationApi, SearchApiMode, SearchApiRequest } from '@kb/contracts';
import type { AuthorizedCandidate } from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { ModelCatalogItem } from './s5-model-ports';
import type { S5ModelGatewayPort } from './s5-model-gateway.port';
import type { ObjectRefRepositoryPort } from './ports';
import type {
  S6FullTextPort,
  S6JobRecord,
  S6ProcessingStorePort,
  S6SegmentRecord,
  S6SourceRecord,
  S6VectorPort,
} from './s06-processing-ports';
import type {
  S7CandidateAuthorizationPort,
  S7CitationPersistencePort,
  S7FullTextSearchPort,
  S7SearchAuditPort,
} from './s7-search.ports';

export type S8CaptionStatus = 'pending' | 'indexed' | 'error';
export type S8VectorStatus = 'pending' | 'indexed' | 'error';

export interface S8ImageSegmentRecord extends S6SegmentRecord {
  imageBlobRefId: string | null;
  imageDescription: string | null;
}

export interface S8ImageModels {
  vlm: ModelCatalogItem;
  visionEmbedding: ModelCatalogItem & {
    dimension: 768 | 1024 | 1536 | 3072;
  };
}

export interface S8ImageModelResolverPort {
  resolve(spaceId: string, context: TenantContext): Promise<S8ImageModels>;
  resolveVisionEmbedding(
    spaceId: string,
    context: TenantContext,
  ): Promise<S8ImageModels['visionEmbedding']>;
  resolveLlm(spaceId: string, context: TenantContext): Promise<ModelCatalogItem>;
}

export interface S8ImageIndexStorePort {
  ensureImageSegment(
    input: {
      source: S6SourceRecord;
      imageBlobRefId: string;
      order?: number;
      metadata?: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<S8ImageSegmentRecord>;
  commit(
    input: {
      segmentId: string;
      expectedVersion: number;
      sourceVersion: number;
      imageBlobRefId: string;
      imageDescription: string;
      captionStatus: S8CaptionStatus;
      vectorStatus: S8VectorStatus;
      captionPromptVersion: string;
      visionEmbeddingModelId: string;
      captionKey: string;
      indexes: S6SegmentRecord['indexes'];
    },
    context: TenantContext,
  ): Promise<S8ImageSegmentRecord | null>;
  markFinalFailure(
    input: {
      sourceId: string;
      sourceVersion: number;
      imageBlobRefId: string;
    },
    context: TenantContext,
  ): Promise<void>;
}

export interface S8CaptionExecutorPort {
  execute(
    job: S6JobRecord,
    context: TenantContext,
  ): Promise<{ result: Record<string, unknown>; value: string }>;
  markFinalFailure(job: S6JobRecord, context: TenantContext): Promise<void>;
  processAsset(
    input: {
      sourceId: string;
      sourceVersion: number;
      imageBlobRefId: string;
      order: number;
      metadata: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<{ segmentId: string; partial: boolean }>;
}

export interface S8CaptionDependencies {
  store: Pick<S6ProcessingStorePort, 'getSource' | 'updateSourceStatus'>;
  objects: Pick<ObjectRefRepositoryPort, 'findObjectRef'>;
  models: S8ImageModelResolverPort;
  gateway: S5ModelGatewayPort;
  tickets: S8ImageTicketPort;
  vectors: S6VectorPort;
  fulltext: S6FullTextPort;
  indexes: S8ImageIndexStorePort;
}

export interface S8ImageTicketPort {
  issueImage(input: {
    workspaceId: string;
    blobId: string;
    sourceId: string | null;
    knowledgeSpaceId: string;
    ttlSeconds: number;
    context: TenantContext;
  }): { url: string; expiresAt: string };
}

export interface S8ImageSearchDependencies {
  access: {
    assertSearchScope(context: TenantContext): void;
    getAuthorizedSpace(spaceId: string, context: TenantContext): Promise<unknown>;
  };
  objects: Pick<ObjectRefRepositoryPort, 'findObjectRef'>;
  models: S8ImageModelResolverPort;
  gateway: S5ModelGatewayPort;
  tickets: S8ImageTicketPort;
  search: {
    collectCandidates(input: {
      request: SearchApiRequest;
      knowledgeSpaceIds: readonly string[];
      mode: SearchApiMode;
      context: TenantContext;
      limit?: number;
    }): Promise<{
      candidates: AuthorizedCandidate[];
      partial: boolean;
      degradedCodes: string[];
      rerankApplied: boolean;
      filterSummary?: { conditionCount: number; conditionHash: string };
      usage: { inputTokens: number; outputTokens: number };
    }>;
  };
  fullText: S7FullTextSearchPort;
  authorization: S7CandidateAuthorizationPort;
  citations: S7CitationPersistencePort;
  audits: S7SearchAuditPort;
  vectors: {
    recall(
      input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        sourceIds?: readonly string[];
        dimension: number;
        embeddingModelId: string;
        vector: readonly number[];
        limit: number;
      },
      context: TenantContext,
    ): Promise<
      Array<{
        vectorId: string;
        workspaceId: string;
        knowledgeSpaceId: string;
        sourceId: string;
        segmentId: string;
        indexId: string;
        version: number;
        score: number;
      }>
    >;
  };
}

export interface S8DeepModelRecords {
  llm: ModelCatalogItem;
  embedding: ModelCatalogItem & {
    dimension: 768 | 1024 | 1536 | 3072;
  };
  rerank?: ModelCatalogItem;
}

export interface S8DeepSearchRepositoryPort {
  resolveModels(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
  ): Promise<S8DeepModelRecords>;
  appendRound(
    input: {
      searchId: string;
      spaceId: string;
      round: number;
      queries: readonly string[];
      candidateCount: number;
      sufficient: boolean;
      modelIds: readonly string[];
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      stopEvidence: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<void>;
}

export type S8DeepStopReason =
  | 'sufficient'
  | 'round_limit'
  | 'token_budget'
  | 'no_new_evidence'
  | 'dependency_failure';

export interface S8DeepRound {
  round: number;
  queries: string[];
  candidateCount: number;
  sufficient: boolean;
}

export interface S8DeepSearchResponse {
  searchId: string;
  mode: 'multi_space';
  items: Array<{
    segment: Record<string, unknown>;
    score: number;
    citation: CitationApi;
  }>;
  partial: boolean;
  durationMs: number;
  degraded?: string[];
  rerankApplied?: boolean;
  rounds: S8DeepRound[];
  stopReason: S8DeepStopReason;
  usage: { inputTokens: number; outputTokens: number };
}
