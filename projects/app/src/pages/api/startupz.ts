import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../runtime/health';

/** GET /startupz（rewrite 到本 API 路由）：初始化完成返回 200，未完成或失败返回 503。 */
export default async function handler(
  _request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  try {
    const runtime = await getRuntime();
    const ready = runtime.startup.state === 'ready';
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'failed',
      checks: [
        {
          name: 'startup',
          status: ready ? 'ok' : 'failed',
          durationMs: Date.now() - runtime.startedAt,
        },
      ],
      durationMs: Date.now() - runtime.startedAt,
    });
  } catch {
    response.status(503).json({
      status: 'failed',
      checks: [{ name: 'startup', status: 'failed', durationMs: 0 }],
      durationMs: 0,
    });
  }
}
