import { ApiErrorException, createApiError } from '@kb/contracts';
import type {
  ImageQuery,
  ModelSelection,
  SearchBudgets,
  SearchRequest,
  SearchVersionPolicy,
  SearchWeights,
} from '@kb/contracts';
import { createLimiter } from '@kb/parse';
import type { AuthSubjectProvider, RequestContext } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetSearchSubject {
  subjectRef: string;
  onBehalfOfTmbId?: string;
  datasetIds: string[];
  collectionIds?: string[];
  tagIds?: string[];
  textQueries?: string[];
  imageQueries?: ImageQuery[];
  models: ModelSelection;
  searchMode: 'embedding' | 'fullTextRecall' | 'mixedRecall';
  limit?: number;
  maxTokens?: number;
  similarity?: number;
  weights?: SearchWeights;
  budgets?: SearchBudgets;
  versionPolicy?: SearchVersionPolicy;
}

/** D3-2 方案 A：按 teamId 的进程内在飞闸门，上限取既有注入值 capacity.providerConcurrency。 */
const teamLimiters = new Map<string, ReturnType<typeof createLimiter>>();

function limiterFor(teamId: string, concurrency: number): ReturnType<typeof createLimiter> {
  let limiter = teamLimiters.get(teamId);
  if (!limiter) {
    limiter = createLimiter({ concurrency });
    teamLimiters.set(teamId, limiter);
  }
  return limiter;
}

/** API-SEARCH-002 POST /api/internal/dataset/search（响应为裸 SearchResult）。 */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const body = parseDto<DatasetSearchSubject>('DatasetSearchSubject', request.body);

    const provider = runtime.extensions.get<AuthSubjectProvider>('identity');
    const subject = provider
      ? await provider.resolve({ subjectRef: body.subjectRef }, requestId)
      : null;
    if (!subject) {
      throw new ApiErrorException(
        createApiError({ code: 501020, requestId, params: { extension: 'identity' } }),
      );
    }
    const tmbId = body.onBehalfOfTmbId ?? subject.tmbId;
    const context: RequestContext = {
      requestId,
      tenant: {
        teamId: subject.teamId,
        tmbId,
        authType: subject.authType,
        isRoot: subject.isRoot,
        ...(subject.sourceName !== undefined ? { sourceName: subject.sourceName } : {}),
      },
      permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
    };

    const hasText = (body.textQueries ?? []).some((query) => query.trim().length > 0);
    if (!hasText && (body.imageQueries ?? []).length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501049,
          requestId,
          params: { allowed: ['textQueries', 'imageQueries'] },
        }),
      );
    }

    const searchRequest: SearchRequest = {
      requestId,
      teamId: subject.teamId,
      tmbId,
      datasetIds: body.datasetIds,
      ...(body.collectionIds !== undefined ? { collectionIds: body.collectionIds } : {}),
      ...(body.tagIds !== undefined ? { tagIds: body.tagIds } : {}),
      textQueries: body.textQueries ?? [],
      imageQueries: body.imageQueries ?? [],
      models: body.models,
      searchMode: body.searchMode,
      limit: body.limit ?? 10,
      maxTokens: body.maxTokens ?? 4_000,
      similarity: body.similarity ?? 0,
      ...(body.weights !== undefined ? { weights: body.weights } : {}),
      ...(body.budgets !== undefined ? { budgets: body.budgets } : {}),
      ...(body.versionPolicy !== undefined ? { versionPolicy: body.versionPolicy } : {}),
    };

    const concurrency = Math.max(1, Math.floor(runtime.config.capacity.providerConcurrency));
    const limiter = limiterFor(subject.teamId, concurrency);
    if (limiter.activeCount >= concurrency) {
      throw new ApiErrorException(
        createApiError({
          code: 501052,
          requestId,
          params: { limit: concurrency, current: limiter.activeCount + 1 },
        }),
      );
    }

    const result = await limiter(() => runtime.datasetSearch.search(searchRequest, context));
    response.status(200).json(result);
  },
  { validationErrorCode: 501050 },
);
