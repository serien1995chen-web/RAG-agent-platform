import type { CitationScore, DegradedInfo, SearchRequest, SearchResult } from '@kb/contracts';

export interface RankedEntry {
  id: string;
  rank: number;
  weight: number;
  type: 'embedding' | 'fullText' | 'image';
}

export interface Candidate {
  docId: string;
  segmentId: string;
  sourceId: string;
  knowledgeSpaceId: string;
  score: number;
  scores: CitationScore[];
  text: string;
}

export interface RecallOutcome {
  items: Candidate[];
  degraded: DegradedInfo[];
}

export interface SearchEngineDeps {
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
    ): Promise<{ segmentId: string; sourceId: string; indexId: string; score: number }[]>;
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
    ): Promise<{ segmentId: string; sourceId: string; score: number }[]>;
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
        items: { id: string; score: number }[];
        options: { timeoutMs: number };
      },
      context: { requestId: string; workspaceId: string },
    ): Promise<{ id: string; score: number }[]>;
  };
}

export interface SearchPipelinePort {
  search(
    request: SearchRequest,
    context: { requestId: string; workspaceId: string },
  ): Promise<SearchResult>;
  searchBatch(
    requests: readonly SearchRequest[],
    context: { requestId: string; workspaceId: string },
  ): Promise<SearchResult[]>;
}

export type RerankFailureMode = 'fallback' | 'strict';

export interface SearchEngineOptions {
  rerankFailureMode?: RerankFailureMode;
}
