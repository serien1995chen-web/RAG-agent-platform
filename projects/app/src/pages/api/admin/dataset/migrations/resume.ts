import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withAdminHandler } from '../../../../../shared/api';
import type { AdminHandlerContext } from '../../../../../shared/api';

interface MigrationResumeBody {
  runId: string;
  cursor: string;
  'Idempotency-Key': string;
}

/** API-ROOT-003 POST /api/admin/dataset/migrations/resume */
export default withAdminHandler(
  async (request: NextApiRequest, response: NextApiResponse, admin: AdminHandlerContext) => {
    const body = parseDto<MigrationResumeBody>('MigrationResumeBody', {
      ...request.body,
      'Idempotency-Key': admin.idempotencyKey,
    });
    const runtime = await getRuntime();
    const result = await runtime.migrationService.resumeMigration(
      {
        runId: body.runId,
        cursor: body.cursor,
        idempotencyKey: body['Idempotency-Key'],
        options: { timeoutMs: 30_000, idempotencyKey: body['Idempotency-Key'] },
      },
      admin.context,
    );
    response
      .status(200)
      .json(successResponse({ runId: result.runId, cursor: result.cursor }, admin.requestId));
  },
  { validationErrorCode: 501025 },
);
