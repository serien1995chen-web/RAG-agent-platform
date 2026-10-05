import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, systemContext } from '../../runtime/health';

/** GET /readyz（rewrite 到本 API 路由）：必需依赖不可用时返回 503，不伪造成功。 */
export default async function handler(
  _request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  try {
    const runtime = await getRuntime();
    const context = systemContext('readyz');
    const required = await runtime.health.checkRequired(context);
    const optional = await runtime.health.checkOptional(context);
    const summary = runtime.health.summarize(required, optional);
    response.status(summary.httpStatus).json(summary.response);
  } catch {
    response.status(503).json({
      status: 'failed',
      checks: [{ name: 'bootstrap', status: 'failed', durationMs: 0 }],
      durationMs: 0,
    });
  }
}
