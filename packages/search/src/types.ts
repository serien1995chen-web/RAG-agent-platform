import type { CitationScore, DegradedInfo, SearchRequest, SearchResult } from '@kb/contracts';

export type SearchChannel = 'embedding' | 'fullText';

export interface RankedEntry {
  id: string;
  rank: number;
  weight: number;
  type: SearchChannel | 'image';
}

export interface Candidate {
  docId: string;
  itemId?: string;
  segmentId?: string;
  sourceId?: string;
  knowledgeSpaceId: string;
  score: number;
  scores: CitationScore[];
  text: string;
  embeddingScore?: number;
  fullTextScore?: number;
  rerankScore?: number;
  indexId?: string;
  indexVersion?: number;
  fullTextVersion?: string | number;
  citationRange?: { start: number; end: number };
  imageIdentity?: string;
  segment?: AuthorizedSegmentSnapshot;
  source?: AuthorizedSourceSnapshot;
}

export interface AuthorizedSegmentSnapshot {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion: number;
  order: number;
  searchEnabled: boolean;
  question: string;
  answer: string;
  content: string;
  metadata: Record<string, unknown>;
  indexes: Array<{
    indexId: string;
    type: string;
    modelId: string;
    dimension: 768 | 1024 | 1536 | 3072;
    vectorProfile: string;
    vectorId: string;
    text: string;
    version: number;
  }>;
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'error' | 'rebuilding' | 'rebuild_failed';
  indexErrorCode: string | null;
  imageBlobRefId: string | null;
  imageDescription?: string | null;
  version: number;
  updatedAt?: string;
}

export interface AuthorizedSourceSnapshot {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  name: string;
  originalUrl: string | null;
  sourceVersion: number;
  permissionRevision: number;
  searchEnabled: boolean;
  deletedAt: string | null;
  updatedAt?: string;
}

export interface AuthorizedCandidate extends Candidate {
  segmentId: string;
  sourceId: string;
  segment: AuthorizedSegmentSnapshot;
  source: AuthorizedSourceSnapshot;
  text: string;
}

export interface SearchHydrationResult {
  items: AuthorizedCandidate[];
  rejected: number;
}

export interface SearchEngineContext {
  requestId: string;
  workspaceId: string;
  memberId?: string;
  traceId?: string;
  apiKeyId?: string;
  scopes?: readonly string[];
  isWorkspaceOwner?: boolean;
}

export interface SearchQueryExpansionHit {
  knowledgeSpaceId: string;
  fileVersion: number;
  logicalMappingId: string;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  matchedTerm: string;
  start: number;
  end: number;
}

export interface SearchQueryExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  hits: SearchQueryExpansionHit[];
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

export interface SearchCandidateHydratorPort {
  hydrate(
    candidates: readonly Candidate[],
    context: SearchEngineContext,
  ): Promise<SearchHydrationResult>;
}

export type ChannelFailureKind = 'rate_limit' | 'model' | 'unavailable' | 'timeout' | 'internal';

export interface ChannelFailure {
  channel: SearchChannel;
  kind: ChannelFailureKind;
  degradedCode: 'vector_recall_failed' | 'fulltext_recall_failed';
  status: 429 | 502 | 503 | 504 | 500;
}

export interface ChannelOutcome {
  channel: SearchChannel;
  attempted: boolean;
  succeeded: boolean;
  failure?: ChannelFailure;
}

export interface RecallOutcome {
  items: Candidate[];
  degraded: DegradedInfo[];
  outcomes: ChannelOutcome[];
  totalOutcomes: number;
  queryExpansions: SearchQueryExpansionResult[];
}

export interface SearchEngineDeps {
  modelUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  vectors: {
    embRecall(
      input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        sourceIds?: string[];
        vector: number[];
        limit: number;
        indexVersion: string;
        options: { timeoutMs: number };
      },
      context: { requestId: string; workspaceId: string },
    ): Promise<
      Array<{
        segmentId: string;
        sourceId: string;
        indexId: string;
        version?: number;
        score: number;
      }>
    >;
  };
  fullText?: {
    search(
      input: {
        knowledgeSpaceId: string;
        sourceIds?: string[];
        text: string;
        limit: number;
        options: { timeoutMs: number };
      },
      context: { requestId: string; workspaceId: string },
    ): Promise<
      Array<{
        segmentId: string;
        sourceId: string;
        fullTextVersion?: string | number;
        score: number;
      }>
    >;
  };
  embedding: {
    embed(
      input: {
        models: SearchRequest['models'];
        texts: string[];
        options: { timeoutMs: number };
      },
      context: { requestId: string; workspaceId: string },
    ): Promise<number[][]>;
  };
  resolveTexts?: (
    candidates: readonly Candidate[],
    context: { requestId: string; workspaceId: string },
  ) => Promise<Map<string, string>>;
  rerank?: {
    rerank(
      input: {
        model: string;
        query: string;
        items: Array<{ id: string; text: string; score: number }>;
        options: { timeoutMs: number };
      },
      context: { requestId: string; workspaceId: string },
    ): Promise<Array<{ id: string; score: number }>>;
  };
  hydrator?: SearchCandidateHydratorPort;
  queryExpansion?: {
    expand(query: string, context: SearchEngineContext): Promise<SearchQueryExpansionResult>;
  };
}

export interface SearchPipelineResult extends SearchResult {
  authorizedCandidates: AuthorizedCandidate[];
  failedChannels: ChannelFailure[];
  status: 200 | 207;
  modelUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  queryExpansions: SearchQueryExpansionResult[];
}

export interface SearchPipelinePort {
  search(request: SearchRequest, context: SearchEngineContext): Promise<SearchPipelineResult>;
  searchBatch(
    requests: readonly SearchRequest[],
    context: SearchEngineContext,
  ): Promise<SearchPipelineResult[]>;
}

export type RerankFailureMode = 'fallback' | 'strict';

export interface SearchEngineOptions {
  rerankFailureMode?: RerankFailureMode;
  finalization?: 'complete' | 'defer';
}
