import {
  loadConsoleDirectory,
  loadKnowledgeRuntimeConfig,
  verifyConsoleSession,
} from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(request: NextApiRequest, response: NextApiResponse): void {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).end();
    return;
  }
  try {
    const config = loadKnowledgeRuntimeConfig();
    if (config.auth.mode !== 'mock' || config.environment === 'production') {
      response.status(503).json({ error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } });
      return;
    }
    const token = request.cookies.kb_console_session;
    const session = token ? verifyConsoleSession(token, config.auth.fixture.token) : null;
    if (!session) {
      response.status(401).json({ error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } });
      return;
    }
    if (
      !session.isWorkspaceOwner &&
      !session.scopes.some((scope) => scope === 'knowledge:manage' || scope === 'knowledge:admin')
    ) {
      response.status(403).json({ error: { code: 'KNOWLEDGE_FORBIDDEN' } });
      return;
    }
    response.status(200).json(loadConsoleDirectory(config, session));
  } catch {
    response.status(503).json({ error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } });
  }
}
