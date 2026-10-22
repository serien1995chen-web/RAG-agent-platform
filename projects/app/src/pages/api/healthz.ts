import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveRequestIdentity } from '../../shared/knowledge-api';

export default function handler(request: NextApiRequest, response: NextApiResponse): void {
  const { requestId, traceId } = resolveRequestIdentity(request);
  response.setHeader('x-request-id', requestId);
  response.setHeader('x-trace-id', traceId);
  response.status(200).json({
    success: true,
    data: {
      status: 'ok',
      checks: [{ name: 'telemetry', status: 'noop', latencyMs: 0 }],
      timestamp: new Date().toISOString(),
    },
    traceId,
    requestId,
  });
}
