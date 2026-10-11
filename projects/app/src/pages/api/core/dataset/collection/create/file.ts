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

const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;
const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface CollectionCreateFileBody {
  datasetId: string;
  fileId: string;
  rawText?: string;
}

/** API-COL-003 POST /api/core/dataset/collection/create/file */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateFileBody>('CollectionCreateFileBody', request.body);
    const useRawText = typeof body.rawText === 'string' && body.rawText.trim().length > 0;
    if (useRawText) {
      const actualBytes = Buffer.byteLength(body.rawText!, 'utf8');
      if (actualBytes > MAX_RAW_TEXT_BYTES) {
        throw apiError(501030, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes });
      }
    }
    const sourceType = useRawText ? 'text' : 'file';
    const sourceRef = useRawText ? body.rawText! : body.fileId;
    const service = createImportSourceService(runtime, resolveSourceProvider(runtime, requestId));
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.fileId,
          sourceRef,
        }),
        sourceType,
        sourceRef,
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { collectionId: result.collectionId, insertLen: result.insertLen },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501030 },
);
