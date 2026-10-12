import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { buildImportSource } from './file';

interface CollectionCreateLinkBody {
  datasetId: string;
  link: string;
  selector?: string;
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return 'link';
  }
}

/** API-COL-004 POST /api/core/dataset/collection/create/link */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateLinkBody>('CollectionCreateLinkBody', request.body);
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'link',
          name: hostOf(body.link),
          tagIds: [],
          sourceRef: body.link,
          trainingPolicy: body.selector ?? null,
        },
        sourceType: 'link',
        sourceRef: body.link,
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: result.collectionId, state: 'ready' }, requestId));
  },
  { validationErrorCode: 501035 },
);
