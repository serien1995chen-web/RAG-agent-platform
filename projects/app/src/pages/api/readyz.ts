import type { NextApiRequest, NextApiResponse } from 'next';
import { requestPathname, resolveRequestIdentity } from '../../shared/knowledge-api';
import { getKnowledgeApiRuntime } from '../../runtime/knowledge-runtime';

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  const { requestId, traceId } = resolveRequestIdentity(request);
  response.setHeader('x-request-id', requestId);
  response.setHeader('x-trace-id', traceId);
  try {
    const result = await getKnowledgeApiRuntime().readiness(requestId);
    response.status(result.status).json(result.body);
  } catch {
    response.status(503).json({
      status: 'down',
      checks: [{ name: 'mongo', status: 'down', latencyMs: 0 }],
      timestamp: new Date().toISOString(),
    });
  }
  void requestPathname(request);
}
