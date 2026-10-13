import type { CitationScore, DegradedInfo, SearchRequest, SearchResult } from '@kb/contracts';

export interface RankedEntry {
  id: string;
  rank: number;
  weight: number;
  type: 'embedding' | 'fullText' | 'image';
}

export interface Candidate {
  docId: string;
  itemId: string;
  collectionId: string;
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
        teamId: string;
        datasetId: string;
        collectionId?: string;
        collectionIds?: string[];
        vector: number[];
        limit: number;
        indexVersion: string;
        options: { timeoutMs: number };
      },
      context: { requestId: string; tenant: { teamId: string; tmbId: string } },
    ): Promise<{ dataId: string; indexId: string; score: number }[]>;
  };
  fullText?: {
    search(
      input: {
        datasetId: string;
        collectionIds?: string[];
        text: string;
        limit: number;
        options: { timeoutMs: number };
      },
      context: { requestId: string; tenant: { teamId: string; tmbId: string } },
    ): Promise<{ dataId: string; collectionId: string; score: number }[]>;
  };
  embedding: {
    embed(
      input: {
        models: SearchRequest['models'];
        texts: string[];
        options: { timeoutMs: number };
      },
      context: { requestId: string; tenant: { teamId: string; tmbId: string } },
    ): Promise<number[][]>;
  };
  resolveTexts?: (
    candidates: readonly Candidate[],
    context: { requestId: string; tenant: { teamId: string; tmbId: string } },
  ) => Promise<Map<string, string>>;
  rerank?: {
    rerank(
      input: {
        model: string;
        items: { id: string; score: number }[];
        options: { timeoutMs: number };
      },
      context: { requestId: string; tenant: { teamId: string; tmbId: string } },
    ): Promise<{ id: string; score: number }[]>;
  };
}

export interface SearchPipelinePort {
  search(
    request: SearchRequest,
    context: { requestId: string; tenant: { teamId: string; tmbId: string } },
  ): Promise<SearchResult>;
  searchBatch(
    requests: readonly SearchRequest[],
    context: { requestId: string; tenant: { teamId: string; tmbId: string } },
  ): Promise<SearchResult[]>;
}

export type SearchEngineOptions = Record<string, never>;
