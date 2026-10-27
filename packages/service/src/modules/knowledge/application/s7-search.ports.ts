import type { CitationApi, SearchApiMode } from '@kb/contracts';
import type {
  AuthorizedCandidate,
  SearchCandidateHydratorPort,
  SearchEngineDeps,
  SourceFilterFacts,
  FilterTagDefinition,
  SearchFilterSummary,
} from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export interface S7AuthorizedSpace {
  spaceId: string;
  workspaceId: string;
  sourcePermissionEnabled: boolean;
}

export interface S7BoundModel {
  modelId: string;
  dimension: 768 | 1024 | 1536 | 3072;
}

export interface S7ResolvedModels {
  embedding: S7BoundModel;
  rerank?: S7BoundModel;
}

export interface S7SearchAccessPort {
  assertSearchScope(context: TenantContext): void;
  getAuthorizedSpace(spaceId: string, context: TenantContext): Promise<S7AuthorizedSpace>;
}

export interface S7ModelResolverPort {
  resolveModels(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
  ): Promise<S7ResolvedModels>;
}

export interface S7FilterFactsResult {
  facts: SourceFilterFacts[];
  definitions: FilterTagDefinition[];
}

export interface S7FilterSourcePort {
  listFilterFacts(
    spaceId: string,
    sourceIds: readonly string[] | undefined,
    context: TenantContext,
  ): Promise<S7FilterFactsResult>;
}

export interface S7FullTextHit {
  segmentId: string;
  sourceId: string;
  fullTextVersion?: string | number;
  score: number;
}

export interface S7FullTextSearchPort {
  search(
    input: {
      knowledgeSpaceId: string;
      sourceIds?: string[];
      text: string;
      limit: number;
      options: { timeoutMs: number };
    },
    context: { requestId: string; workspaceId: string },
  ): Promise<S7FullTextHit[]>;
}

export interface S7CandidateAuthorizationPort extends SearchCandidateHydratorPort {
  reauthorizeCitation(
    input: {
      knowledgeSpaceId: string;
      sourceId: string;
      segmentId: string;
    },
    context: TenantContext,
  ): Promise<AuthorizedCandidate | undefined>;
}

export interface S7SearchPipelineFactoryInput {
  space: S7AuthorizedSpace;
  models: S7ResolvedModels;
  usingRerank: boolean;
  context: TenantContext;
}

export interface S7SearchPipelineFactoryPort {
  create(input: S7SearchPipelineFactoryInput): SearchEngineDeps;
}

export interface S7CitationIssueInput {
  searchId: string;
  searchMode: SearchApiMode | 'multi_space';
  spaceId: string;
  candidates: readonly AuthorizedCandidate[];
  partial: boolean;
  durationMs: number;
  degradedCodes: string[];
  filterSummary?: SearchFilterSummary;
  now: Date;
}

export interface S7CitationReaderRecord {
  citationId: string;
  searchRequestId: string;
  knowledgeSpaceId: string;
  segmentId: string;
  sourceId: string;
  title: string;
  sourceUrl: string | null;
  segmentRange: { start: number; end: number };
  score: number;
  snapshotHash: string;
  expiresAt: Date;
}

export interface S7CitationPersistencePort {
  issueWithAudit(
    input: S7CitationIssueInput,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, CitationApi>>;
  findCurrent(citationId: string, context: TenantContext): Promise<S7CitationReaderRecord | null>;
}

export interface S7SearchAuditPort {
  appendSearch(
    input: {
      searchId: string;
      searchMode: SearchApiMode | 'multi_space';
      spaceId: string;
      outcome: 'succeeded' | 'failed';
      partial: boolean;
      resultCount: number;
      degradedCodes: string[];
      durationMs: number;
      filterSummary?: SearchFilterSummary;
      failureCode?: string;
    },
    context: TenantContext,
  ): Promise<void>;
}

export interface S7SearchApplicationDependencies {
  access: S7SearchAccessPort;
  models: S7ModelResolverPort;
  filters: S7FilterSourcePort;
  fullText: S7FullTextSearchPort;
  authorization: S7CandidateAuthorizationPort;
  pipeline: S7SearchPipelineFactoryPort;
  citations: S7CitationPersistencePort;
  audits: S7SearchAuditPort;
  now?: () => Date;
  searchIdFactory?: () => string;
  totalTimeoutMs?: {
    single?: number;
    multi?: number;
  };
}

export interface S7CitationSignerPort {
  issue(workspaceId: string, uuid?: string): string;
  verify(citationId: string, workspaceId: string): boolean;
}
