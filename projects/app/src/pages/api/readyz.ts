import type { NextApiRequest, NextApiResponse } from 'next';
import { createKnowledgeError } from '@kb/contracts';
import { resolveRequestIdentity } from '../../shared/knowledge-api';
import { getKnowledgeApiRuntime } from '../../runtime/knowledge-runtime';

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  const { requestId, traceId } = resolveRequestIdentity(request);
  response.setHeader('x-request-id', requestId);
  response.setHeader('x-trace-id', traceId);
  try {
    const result = await (await getKnowledgeApiRuntime()).readiness(requestId);
    if (result.status === 200) {
      response.status(200).json({
        success: true,
        data: result.body,
        traceId,
        requestId,
      });
      return;
    }
    response.status(result.status).json(
      createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId,
        traceId,
        details: {
          checks: result.body.checks.filter((check) => check.status === 'down'),
        },
      }).problem,
    );
  } catch {
    response.status(503).json(
      createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId,
        traceId,
        details: { dependency: 'runtime' },
      }).problem,
    );
  }
}
