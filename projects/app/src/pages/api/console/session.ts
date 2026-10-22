import { createConsoleSession, loadKnowledgeRuntimeConfig } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(request: NextApiRequest, response: NextApiResponse): void {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    response.status(405).end();
    return;
  }
  try {
    const config = loadKnowledgeRuntimeConfig();
    if (config.auth.mode !== 'mock' || config.environment === 'production') {
      response.status(503).json({ error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } });
      return;
    }
    const fixture = config.auth.fixture;
    const session = createConsoleSession(
      {
        workspaceId: fixture.workspaceId,
        memberId: fixture.memberId,
        scopes: fixture.scopes,
        isWorkspaceOwner: fixture.isWorkspaceOwner,
      },
      fixture.token,
    );
    response.setHeader(
      'Set-Cookie',
      `kb_console_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
    );
    response.status(200).json({
      workspaceId: fixture.workspaceId,
      memberId: fixture.memberId,
      scopes: fixture.scopes,
      isWorkspaceOwner: fixture.isWorkspaceOwner,
      expiresIn: 3600,
    });
  } catch {
    response.status(503).json({ error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } });
  }
}
