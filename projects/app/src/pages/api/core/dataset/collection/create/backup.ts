import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { PORT_OPTIONS, apiError, sourceCollection } from '../../../../../../shared/import-source';

interface CollectionCreateBackupForm {
  file?: unknown;
  datasetId: string;
  parentId?: string;
  header?: unknown;
}

function validateQaHeaders(header: unknown): { ok: boolean; duplicate: boolean } {
  if (!Array.isArray(header)) return { ok: false, duplicate: false };
  const normalized = header.map((value) => String(value).trim().toLowerCase());
  return {
    ok: normalized.includes('q') && normalized.includes('a'),
    duplicate: new Set(normalized).size !== normalized.length,
  };
}

/** API-COL-009 POST /api/core/dataset/collection/create/backup */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateBackupForm>('CollectionCreateBackupForm', request.body);
    if (body.file === undefined || body.file === null) {
      throw apiError(501058, requestId, { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
    }
    const check = validateQaHeaders(body.header);
    if (!check.ok) {
      throw apiError(501058, requestId, { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
    }
    if (check.duplicate) {
      throw apiError(501059, requestId, { sheet: 'sheet1' });
    }
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          name: 'backup',
          sourceRef: 'backup',
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, insertLen: 0 }, requestId));
  },
  { validationErrorCode: 501059 },
);
