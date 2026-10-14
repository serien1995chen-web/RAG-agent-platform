import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withAdminHandler } from '../../../../../shared/api';
import type { AdminHandlerContext } from '../../../../../shared/api';

interface MigrationDryRunBody {
  version: string;
  scope: {
    teamIds?: string[];
    datasetIds?: string[];
    collectionIds?: string[];
    operationTypes?: Array<'migrate' | 'reconcile' | 'report' | 'cleanup'>;
  };
}

/** API-ROOT-001 POST /api/admin/dataset/migrations/dry-run */
export default withAdminHandler(
  async (request: NextApiRequest, response: NextApiResponse, admin: AdminHandlerContext) => {
    const body = parseDto<MigrationDryRunBody>('MigrationDryRunBody', request.body);
    const runtime = await getRuntime();
    const result = await runtime.migrationService.dryRunMigration(
      {
        version: body.version,
        scope: body.scope,
        options: { timeoutMs: 30_000 },
      },
      admin.context,
    );
    response.status(200).json(successResponse({ report: result.report }, admin.requestId));
  },
  { validationErrorCode: 501025 },
);
