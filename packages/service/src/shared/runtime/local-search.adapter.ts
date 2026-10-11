import type { Citation, SearchRequest, SearchResult } from '@kb/contracts';
import type {
  DatasetSearchPort,
  FullTextHit,
  FullTextStore,
  VectorController,
  VectorSearchHit,
} from '../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../ports/repositories';
import type {
  CollectionSnapshot,
  KnowledgeItemSnapshot,
  PortCallOptions,
  RequestContext,
} from '../../ports/types';

export interface LocalSearchDeps {
  vectors: VectorController;
  fullText: FullTextStore;
  embed: (text: string, context: RequestContext) => Promise<number[]>;
  items: KnowledgeItemRepository & {
    get?: (
      input: { dataId: string; options: PortCallOptions },
      context: RequestContext,
    ) => Promise<KnowledgeItemSnapshot | null>;
  };
  collections: {
    getCollection(
      input: { collectionId: string; options: PortCallOptions },
      context: RequestContext,
    ): Promise<CollectionSnapshot>;
  };
}

const RRF_K = 60;

function fuse(lists: Array<Array<{ id: string; rank: number }>>): Record<string, number> {
  const fused: Record<string, number> = {};
  for (const list of lists) {
    for (const item of list) {
      fused[item.id] = (fused[item.id] ?? 0) + 1 / (RRF_K + item.rank);
    }
  }
  return fused;
}

function reasonOf(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const apiError = (error as { error?: { code?: number } }).error;
    if (apiError?.code) return `error_${apiError.code}`;
  }
  return error instanceof Error ? error.message.slice(0, 200) : fallback;
}

/**
 * 真实 DatasetSearchPort（用户授权 (b) 跨阶段接线）：
 * 向量召回 + 全文召回 → RRF 融合 → Citation。任一路失败写入 stats.degraded[]，不伪造完整结果。
 */
export function createLocalDatasetSearchPort(deps: LocalSearchDeps): DatasetSearchPort {
  async function run(request: SearchRequest, context: RequestContext): Promise<SearchResult> {
    const startedAt = Date.now();
    const degraded: Array<{ stage: string; reason: string }> = [];
    const datasetId = request.datasetIds[0] ?? '';
    const text = request.textQueries[0] ?? '';
    const limit = request.limit ?? 10;
    const options: PortCallOptions = { timeoutMs: 5000 };

    let vectorHits: VectorSearchHit[] = [];
    if (text.length > 0) {
      try {
        const vector = await deps.embed(text, context);
        vectorHits = await deps.vectors.embRecall(
          { teamId: context.tenant.teamId, datasetId, vector, limit, options },
          context,
        );
      } catch (error) {
        degraded.push({ stage: 'vector', reason: reasonOf(error, 'vector_failed') });
      }
    }

    let fullTextHits: FullTextHit[] = [];
    if (text.length > 0) {
      try {
        fullTextHits = await deps.fullText.search({ datasetId, text, limit, options }, context);
      } catch (error) {
        degraded.push({ stage: 'fullText', reason: reasonOf(error, 'fulltext_failed') });
      }
    }

    const fused = fuse([
      vectorHits.map((hit, index) => ({ id: hit.dataId, rank: index + 1 })),
      fullTextHits.map((hit, index) => ({ id: hit.dataId, rank: index + 1 })),
    ]);
    const ordered = Object.entries(fused)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const citations: Citation[] = [];
    for (const [dataId, score] of ordered) {
      const item = await deps.items.get?.({ dataId, options }, context);
      if (!item) continue;
      let collectionName = '';
      let sourceType: Citation['sourceType'] = 'file';
      try {
        const collection = await deps.collections.getCollection(
          { collectionId: item.collectionId, options },
          context,
        );
        collectionName = collection.name;
        sourceType = collection.type === 'virtual' ? 'virtual' : 'file';
      } catch {
        // 名称缺失不阻断召回结果。
      }
      citations.push({
        dataId,
        chunkIndex: 0,
        datasetId: item.datasetId,
        collectionId: item.collectionId,
        collectionName,
        sourceName: collectionName,
        sourceType,
        quoteText: [item.q, item.a].filter(Boolean).join('\n'),
        updateTime: item.updateTime,
        scores: [{ type: 'rrf', value: score, index: 0 }],
      });
    }

    return {
      citations,
      stats: {
        searchMode: request.searchMode,
        usingReRank: false,
        usingSimilarityFilter: (request.similarity ?? 0) > 0,
        embeddingTokens: 0,
        rerankInputTokens: 0,
        degraded,
        durationMs: Date.now() - startedAt,
      } as SearchResult['stats'],
    };
  }

  return {
    search: run,
    searchBatch: (requests, context) =>
      Promise.all(requests.map((request) => run(request, context))),
  };
}
