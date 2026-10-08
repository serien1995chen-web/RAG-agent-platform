import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetUpdateBody {
  datasetId: string;
  version: number;
  name?: string;
  chunkPolicy?: {
    mode: 'auto' | 'paragraph' | 'custom';
    chunkSize: number;
    minSize: number;
    maxSize: number;
    overlapRatio: number;
    paragraphDeep: number;
    customRegs: string[];
    lengthUnit: 'char' | 'token';
    forceSplit: boolean;
    maxChunks: number;
  };
  autoSync?: boolean;
}

/** API-DS-004 POST /api/core/dataset/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DatasetUpdateBody>('DatasetUpdateBody', request.body);
    const updated = await runtime.datasetApi.updateDataset(
      {
        datasetId: body.datasetId,
        version: body.version,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.chunkPolicy !== undefined ? { chunkPolicy: body.chunkPolicy } : {}),
        ...(body.autoSync !== undefined ? { autoSync: body.autoSync } : {}),
      },
      context,
    );
    response.status(200).json(successResponse(updated, requestId));
  },
  { validationErrorCode: 501004 },
);
