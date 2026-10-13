import { ApiErrorException, SEARCH_BATCH_LIMIT, createApiError } from '@kb/contracts';
import type {
  Citation,
  CitationScore,
  DegradedInfo,
  SearchRequest,
  SearchResult,
} from '@kb/contracts';
import type { Candidate, SearchPipelinePort } from '@kb/search';
import { Types, type Connection } from 'mongoose';
import type { DatasetSearchPort } from '../../../ports/capabilities';
import type { CollectionRepository } from '../../../ports/repositories';
import type { RequestContext } from '../../../ports/types';
import { validateTenantContext } from '../../../ports/types';
import {
  registerMongoModels,
  type DatasetCollectionDoc,
  type DatasetDataDoc,
  type RegisteredModels,
} from '../../../shared/persistence/schemas';
import { parseCollectionFilterMatch } from '../../../../../search/src/recall';
import { resolveQueryIndexVersion } from '../domain/index-version';

type CitationSourceType = Citation['sourceType'];

interface ResolvedCitationInput {
  dataId: string;
  chunkIndex: number;
  datasetId: string;
  collectionId: string;
  collectionName: string;
  sourceName: string;
  sourceType: CitationSourceType;
  quoteText: string;
  updateTime: string;
  scores: CitationScore[];
  imageIds?: string[];
}

interface CitationBuilder {
  build(input: { items: ResolvedCitationInput[]; context: RequestContext }): Promise<Citation[]>;
}

interface ImageRecallDependency {
  recall(
    input: {
      datasetId: string;
      imageQueries: SearchRequest['imageQueries'];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<unknown[]>;
}

export interface DatasetSearchAdapterDeps {
  engine: SearchPipelinePort;
  connection: Connection;
  collections: CollectionRepository;
  datasetIndexVersion: (datasetId: string, context: RequestContext) => Promise<string>;
  citationBuilder?: CitationBuilder;
  imageRecall?: ImageRecallDependency;
}

interface NormalizedSearch {
  request: SearchRequest;
  matched: boolean;
  indexVersion: string;
}

interface CitationResolution {
  citations: Citation[];
  degraded: DegradedInfo[];
}

function normalizeQaText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function sourceTypeOf(value: string): CitationSourceType {
  if (
    value === 'file' ||
    value === 'link' ||
    value === 'apiFile' ||
    value === 'externalFile' ||
    value === 'images' ||
    value === 'virtual'
  ) {
    return value;
  }
  return 'virtual';
}

function emptyResult(request: SearchRequest, degraded: DegradedInfo[] = []): SearchResult {
  return {
    citations: [],
    stats: {
      searchMode: request.searchMode,
      usingReRank: false,
      usingSimilarityFilter: request.similarity > 0,
      embeddingTokens: 0,
      rerankInputTokens: 0,
      degraded,
      durationMs: 0,
    },
  };
}

export class DatasetSearchAdapter implements DatasetSearchPort {
  private readonly models: RegisteredModels;

  constructor(private readonly deps: DatasetSearchAdapterDeps) {
    this.models = registerMongoModels(deps.connection);
  }

  private error(
    context: RequestContext,
    code: number,
    params: Record<string, unknown>,
  ): ApiErrorException {
    return new ApiErrorException(createApiError({ code, requestId: context.requestId, params }));
  }

  private async normalize(
    request: SearchRequest,
    context: RequestContext,
  ): Promise<NormalizedSearch> {
    const tenant = validateTenantContext(context.tenant, context.requestId);
    if (!tenant.ok) throw new ApiErrorException(tenant.error);

    const teamId = context.tenant.teamId;
    const datasetId = request.datasetIds[0] ?? '';
    if (request.teamId !== teamId) {
      throw this.error(context, 501070, {
        resourceType: 'dataset',
        resourceId: datasetId,
      });
    }

    const currentVersion = await this.deps.datasetIndexVersion(datasetId, context);
    const indexVersion = resolveQueryIndexVersion(
      {
        mode: request.versionPolicy?.mode ?? 'latest',
        pinned: request.versionPolicy?.pinned,
        currentVersion,
      },
      context,
    );

    const parsed = request.collectionFilterMatch
      ? parseCollectionFilterMatch(request.collectionFilterMatch)
      : { matched: true, tagsAnd: [], tagsOr: [] };
    if (!parsed.matched) {
      return {
        request: {
          ...request,
          collectionIds: [],
          tagIds: Array.from(
            new Set([...(request.tagIds ?? []), ...parsed.tagsAnd, ...parsed.tagsOr]),
          ),
          versionPolicy: { mode: 'pinned', pinned: indexVersion },
        },
        matched: false,
        indexVersion,
      };
    }

    const options = { timeoutMs: request.budgets?.recallTimeoutMs ?? 5_000 };
    const listed = await this.deps.collections.list(
      { datasetId, parentId: null, page: 1, limit: 1_000, options },
      context,
    );
    const requiredTags = new Set<string>([...(request.tagIds ?? []), ...parsed.tagsAnd]);
    const optionalTags = new Set<string>(parsed.tagsOr);
    const requestedCollectionIds = new Set(request.collectionIds ?? []);
    const hasCollectionFilter = requestedCollectionIds.size > 0;
    const hasTagFilter = requiredTags.size > 0 || optionalTags.size > 0;

    const selected = listed.list.filter((collection) => {
      if (hasCollectionFilter && !requestedCollectionIds.has(collection.collectionId)) return false;
      if ([...requiredTags].some((tagId) => !collection.tagIds.includes(tagId))) return false;
      if (
        optionalTags.size > 0 &&
        ![...optionalTags].some((tagId) => collection.tagIds.includes(tagId))
      ) {
        return false;
      }
      return true;
    });
    const matched = !(hasCollectionFilter || hasTagFilter) || selected.length > 0;
    const mergedTagIds = Array.from(new Set([...requiredTags, ...optionalTags]));

    return {
      request: {
        ...request,
        collectionIds:
          selected.length > 0 ? selected.map((item) => item.collectionId) : request.collectionIds,
        tagIds: mergedTagIds.length > 0 ? mergedTagIds : request.tagIds,
        versionPolicy: { mode: 'pinned', pinned: indexVersion },
      },
      matched,
      indexVersion,
    };
  }

  private async resolveCitations(
    citations: Citation[],
    context: RequestContext,
  ): Promise<CitationResolution> {
    if (citations.length === 0) return { citations: [], degraded: [] };

    const degraded: DegradedInfo[] = [];
    const teamId = new Types.ObjectId(context.tenant.teamId);
    const dataIds = [...new Set(citations.map((citation) => citation.dataId))];
    const datasetIds = [...new Set(citations.map((citation) => citation.datasetId))];
    const dataObjectIds = dataIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const dataDocs = (await this.models.DatasetData.find({
      teamId,
      datasetId: { $in: datasetIds.map((id) => new Types.ObjectId(id)) },
      $or: [{ _id: { $in: dataObjectIds } }, { 'indexes.dataId': { $in: dataIds } }],
    })
      .lean()
      .exec()) as unknown as (DatasetDataDoc & { _id: Types.ObjectId })[];

    const collectionObjectIds = [...new Set(dataDocs.map((doc) => String(doc.collectionId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const collectionDocs = (await this.models.DatasetCollection.find({
      teamId,
      _id: { $in: collectionObjectIds },
    })
      .lean()
      .exec()) as unknown as (DatasetCollectionDoc & { _id: Types.ObjectId })[];

    const dataById = new Map(dataDocs.map((doc) => [String(doc._id), doc]));
    const dataByIndexId = new Map<string, DatasetDataDoc & { _id: Types.ObjectId }>();
    for (const doc of dataDocs) {
      for (const index of doc.indexes) {
        if (typeof index.dataId === 'string') dataByIndexId.set(index.dataId, doc);
      }
    }
    const collectionById = new Map(collectionDocs.map((doc) => [String(doc._id), doc]));
    const resolved: ResolvedCitationInput[] = [];

    for (const citation of citations) {
      const doc = dataById.get(citation.dataId) ?? dataByIndexId.get(citation.dataId);
      if (!doc) {
        degraded.push({ stage: 'citation', reason: 'item_missing' });
        continue;
      }
      const matchedIndex =
        doc.indexes.find((index) => index.dataId === citation.dataId) ?? doc.indexes[0];
      const collection = collectionById.get(String(doc.collectionId));
      const collectionName = collection?.name ?? citation.collectionName ?? 'unknown';
      const sourceType = sourceTypeOf(collection?.type ?? citation.sourceType);
      resolved.push({
        dataId: String(doc._id),
        chunkIndex: doc.chunkIndex ?? 0,
        datasetId: String(doc.datasetId),
        collectionId: String(doc.collectionId),
        collectionName,
        sourceName: collection?.name ?? citation.sourceName ?? 'unknown',
        sourceType,
        quoteText: matchedIndex?.text ?? doc.q ?? doc.a,
        updateTime: doc.updateTime.toISOString(),
        scores: citation.scores,
        ...(doc.imageId !== null ? { imageIds: [doc.imageId] } : {}),
      });
    }

    if (this.deps.citationBuilder) {
      return {
        citations: await this.deps.citationBuilder.build({ items: resolved, context }),
        degraded,
      };
    }

    return {
      citations: resolved.map((item) => ({
        dataId: item.dataId,
        chunkIndex: item.chunkIndex,
        datasetId: item.datasetId,
        collectionId: item.collectionId,
        collectionName: item.collectionName,
        sourceName: item.sourceName,
        sourceType: item.sourceType,
        quoteText: item.quoteText,
        updateTime: item.updateTime,
        scores: item.scores,
      })),
      degraded,
    };
  }

  async search(request: SearchRequest, context: RequestContext): Promise<SearchResult> {
    const normalized = await this.normalize(request, context);
    if (!normalized.matched) return emptyResult(request);
    const result = await this.deps.engine.search(normalized.request, context);
    const resolved = await this.resolveCitations(result.citations, context);
    return {
      citations: resolved.citations,
      stats: {
        ...result.stats,
        degraded: [...result.stats.degraded, ...resolved.degraded],
      },
    };
  }

  async searchBatch(requests: SearchRequest[], context: RequestContext): Promise<SearchResult[]> {
    if (requests.length > SEARCH_BATCH_LIMIT) {
      throw this.error(context, 501050, {
        field: 'requests',
        value: requests.length,
        rangeOrVersion: '1-10',
      });
    }
    return Promise.all(
      requests.map(async (request) => {
        try {
          return await this.search(request, context);
        } catch (caught) {
          return emptyResult(request, [
            {
              stage: 'request',
              reason: caught instanceof Error ? caught.message : String(caught),
            },
          ]);
        }
      }),
    );
  }
}

export function createDatasetSearchPort(deps: DatasetSearchAdapterDeps): DatasetSearchPort {
  return new DatasetSearchAdapter(deps);
}

export function createTextResolver(
  connection: Connection,
): (
  candidates: readonly Candidate[],
  context: { requestId: string; tenant: { teamId: string; tmbId: string } },
) => Promise<Map<string, string>> {
  const models = registerMongoModels(connection);

  return async (candidates, context) => {
    const teamId = new Types.ObjectId(context.tenant.teamId);
    const parsed = candidates.flatMap((candidate) => {
      const separator = candidate.docId.indexOf(':');
      if (separator <= 0) return [];
      const datasetId = candidate.docId.slice(0, separator);
      const rawDataId = candidate.docId.slice(separator + 1);
      const dataId = rawDataId.split(':')[0] ?? rawDataId;
      if (!Types.ObjectId.isValid(datasetId) || !Types.ObjectId.isValid(dataId)) return [];
      return [{ candidate, datasetId, dataId }];
    });

    const datasetIds = [...new Set(parsed.map((item) => item.datasetId))].map(
      (id) => new Types.ObjectId(id),
    );
    const dataIds = [...new Set(parsed.map((item) => item.dataId))].map(
      (id) => new Types.ObjectId(id),
    );
    const docs =
      parsed.length === 0
        ? []
        : ((await models.DatasetData.find({
            teamId,
            datasetId: { $in: datasetIds },
            _id: { $in: dataIds },
          })
            .select('q a')
            .lean()
            .exec()) as unknown as { _id: Types.ObjectId; q: string | null; a: string }[]);
    const textByDataId = new Map(
      docs.map((doc) => [
        String(doc._id),
        `${normalizeQaText(doc.q ?? '')}${normalizeQaText(doc.a ?? '')}`,
      ]),
    );
    const resolved = new Map<string, string>();
    for (const item of parsed) {
      resolved.set(item.candidate.docId, textByDataId.get(item.dataId) ?? '');
    }
    return resolved;
  };
}
