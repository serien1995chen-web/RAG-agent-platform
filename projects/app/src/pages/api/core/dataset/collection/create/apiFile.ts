import { createHash } from 'node:crypto';
import type { DatasetSourceProvider } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { buildImportSource } from './file';

interface CollectionCreateApiFileBody {
  datasetId: string;
  apiConfig: unknown;
  path: string;
}

/** 稳定 apiConfigId：provider + credentialRef + endpointRef 的短哈希（无需新增 DTO 字段）。 */
export function apiConfigIdentity(config: unknown): string {
  const value = (config ?? {}) as {
    provider?: string;
    credentialRef?: string;
    endpointRef?: string;
  };
  return createHash('sha256')
    .update(`${value.provider ?? ''}|${value.credentialRef ?? ''}|${value.endpointRef ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** API-COL-007 POST /api/core/dataset/collection/create/apiFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateApiFileBody>('CollectionCreateApiFileBody', request.body);
    const base = runtime.datasetSourceProvider;
    // 请求级 provider 包装：仅注入本次调用的 apiConfig，不复制 Provider 逻辑。
    const provider: DatasetSourceProvider = {
      read: (sourceRequest, sourceContext) =>
        base.read({ ...sourceRequest, apiConfig: body.apiConfig as never }, sourceContext),
      preview: (sourceRequest, sourceContext) =>
        base.preview({ ...sourceRequest, apiConfig: body.apiConfig as never }, sourceContext),
    };
    const service = buildImportSource(runtime, provider);
    // 持久化标识与 list/listExistId 共用同一编码；Provider 读取仍使用原始 path。
    const sourceRef = `apiFile:${apiConfigIdentity(body.apiConfig)}:${body.path}`;
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'apiFile',
          name: body.path,
          tagIds: [],
          sourceRef,
          trainingPolicy: null,
        },
        sourceType: 'apiFile',
        sourceRef: body.path,
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501017 },
);
