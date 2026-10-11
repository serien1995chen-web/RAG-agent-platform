import type {
  CollectionRepository,
  CollectionSnapshot,
  DatasetSourceProvider,
  ProcessingJobRepository,
  ServicePorts,
} from '@kb/service';
import type { QueuePort } from '@kb/dal';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { ImportSourceService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

function sourceCollection(input: {
  teamId: string;
  datasetId: string;
  name: string;
  sourceRef: string;
  type?: string;
  parentId?: string | null;
}): Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'> {
  return {
    teamId: input.teamId,
    datasetId: input.datasetId,
    parentId: input.parentId ?? null,
    type: input.type ?? 'file',
    name: input.name,
    tagIds: [],
    sourceRef: input.sourceRef,
  };
}

type ImportRuntimeLike = {
  collectionRepository: CollectionRepository;
  processingRepository: ProcessingJobRepository;
  ports: ServicePorts;
};

function resolveSourceProvider(
  runtime: { ports: { datasetSourceProvider?: DatasetSourceProvider } },
  requestId: string,
): DatasetSourceProvider {
  const provider = runtime.ports.datasetSourceProvider;
  if (!provider) {
    throw new ApiErrorException(
      createApiError({ code: 501017, requestId, params: { provider: 'source' } }),
    );
  }
  return provider;
}

function createImportSourceService(
  runtime: ImportRuntimeLike,
  sourceProvider: DatasetSourceProvider,
): ImportSourceService {
  const queue = (runtime.ports as { queue?: QueuePort }).queue;
  return new ImportSourceService({
    collections: runtime.collectionRepository,
    sourceProvider,
    trainingProcessor: runtime.ports.trainingProcessor,
    jobs: runtime.processingRepository,
    ...(queue ? { queue } : {}),
  });
}

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface CollectionCreateApiFileBody {
  datasetId: string;
  apiConfig: unknown;
  path: string;
}

/** API-COL-007 POST /api/core/dataset/collection/create/apiFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateApiFileBody>('CollectionCreateApiFileBody', request.body);
    // 先校验 Dataset 归属，再走 Provider。
    await runtime.datasetApi.getDatasetDetail(body.datasetId, context);
    let provider;
    try {
      provider = resolveSourceProvider(runtime, requestId);
    } catch {
      throw apiError(501017, requestId, { provider: 'apiFile' });
    }
    // 不再把 {config,path} JSON 当 URL；Provider 未配置时返回稳定 501062/501017。
    const sourceRef = body.path;
    const service = createImportSourceService(runtime, provider);
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.path,
          sourceRef,
        }),
        sourceType: 'apiFile',
        sourceRef,
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501039 },
);
