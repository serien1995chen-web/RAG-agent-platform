import { BullMqQueueAdapter, type QueuePort } from '@kb/dal';
import { ImportSourceService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { verifyUploadToken } from '../../file/presignUpload';

interface CollectionCreateFileBody {
  datasetId: string;
  fileId: string;
  rawText?: string;
  customPdfParse?: boolean;
}

const queueCache = new WeakMap<object, QueuePort>();

export function resolveQueue(runtime: ExtendedAppRuntime): QueuePort | undefined {
  const injected = (runtime.clients as unknown as { queue?: QueuePort }).queue;
  if (injected) return injected;
  const redis = runtime.clients.redis as unknown as object | undefined;
  if (!redis) return undefined;
  const cached = queueCache.get(redis);
  if (cached) return cached;
  const created = new BullMqQueueAdapter({ connection: runtime.clients.redis as never });
  queueCache.set(redis, created);
  return created;
}

export function buildImportSource(
  runtime: ExtendedAppRuntime,
  provider = runtime.datasetSourceProvider,
): ImportSourceService {
  return new ImportSourceService({
    collections: runtime.collectionRepository,
    sourceProvider: provider,
    trainingProcessor: runtime.ports.trainingProcessor,
    jobs: runtime.processingRepository,
    queue: resolveQueue(runtime),
  });
}

function baseName(key: string): string {
  const segment = key.split('/').pop() ?? 'file';
  return segment.length > 0 ? segment : 'file';
}

/** API-COL-003 POST /api/core/dataset/collection/create/file */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateFileBody>('CollectionCreateFileBody', request.body);
    const payload = verifyUploadToken(body.fileId, context);
    const useRawText = typeof body.rawText === 'string';
    const sourceType = useRawText ? 'text' : 'file';
    const sourceRef = useRawText ? (body.rawText ?? '') : payload.key;
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'file',
          name: baseName(payload.key),
          tagIds: [],
          sourceRef,
          trainingPolicy: null,
        },
        sourceType,
        sourceRef,
        options: { timeoutMs: 30_000 },
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
