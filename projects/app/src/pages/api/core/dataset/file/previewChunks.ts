import { chunkText, type ChunkPolicy } from '../../../../../../../../packages/chunk/src/index';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import { objectKeyHash } from '@kb/storage';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { objectRefOf, verifyUploadToken } from './presignUpload';

interface PreviewChunksBody {
  fileRef: string;
  chunkPolicy: ChunkPolicy;
}

function extensionOf(key: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(key);
  return match?.[1] ?? '';
}

/** API-FILE-004 POST /api/core/dataset/file/previewChunks（零正式副作用） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewChunksBody>('PreviewChunksBody', request.body);
    const payload = verifyUploadToken(body.fileRef, context);
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const object = await objectStore.get(
      {
        ref: objectRefOf(payload),
        options: { timeoutMs: 30_000 },
        datasetId: payload.datasetId,
      },
      context,
    );
    const parser = createDefaultDocumentParser();
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: payload.datasetId,
      fileRef: objectKeyHash(payload.key),
      extension: extensionOf(payload.key),
      timeoutMs: 30_000,
      bytes: object.body,
    };
    const parsed = await parser.parse(parseRequest);
    const chunks = chunkText({ text: parsed.rawText, policy: body.chunkPolicy });
    response.status(200).json(
      successResponse(
        {
          chunks: chunks.chunks.map((chunk) => ({
            index: chunk.index,
            text: chunk.text,
            contentHash: chunk.contentHash,
          })),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501056 },
);
