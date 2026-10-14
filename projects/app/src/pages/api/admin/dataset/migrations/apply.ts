import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withAdminHandler } from '../../../../../shared/api';
import type { AdminHandlerContext } from '../../../../../shared/api';

interface MigrationApplyBody {
  version: string;
  scope: {
    teamIds?: string[];
    datasetIds?: string[];
    collectionIds?: string[];
    operationTypes?: Array<'migrate' | 'reconcile' | 'report' | 'cleanup'>;
  };
  'Idempotency-Key': string;
}

/** API-ROOT-002 POST /api/admin/dataset/migrations/apply */
export default withAdminHandler(
  async (request: NextApiRequest, response: NextApiResponse, admin: AdminHandlerContext) => {
    const body = parseDto<MigrationApplyBody>('MigrationApplyBody', {
      ...request.body,
      'Idempotency-Key': admin.idempotencyKey,
    });
    const runtime = await getRuntime();
    const result = await runtime.migrationService.applyMigration(
      {
        version: body.version,
        scope: body.scope,
        idempotencyKey: body['Idempotency-Key'],
        options: { timeoutMs: 30_000, idempotencyKey: body['Idempotency-Key'] },
      },
      admin.context,
    );
    response.status(200).json(successResponse({ runId: result.runId }, admin.requestId));
  },
  { validationErrorCode: 501025 },
);
