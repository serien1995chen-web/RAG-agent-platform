import { liveProbeResponse } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';

/** GET /healthz/live（rewrite 到本 API 路由）：只证明进程存活。 */
export default function handler(_request: NextApiRequest, response: NextApiResponse): void {
  response.status(200).json(liveProbeResponse());
}
