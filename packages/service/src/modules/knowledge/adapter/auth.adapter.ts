import { createKnowledgeError } from '@kb/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { KnowledgeRuntimeConfig } from '../../../shared/config/knowledge-runtime-config';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { verifyConsoleSession } from './console-session';

export interface KnowledgeSubject {
  memberId: string;
  workspaceIds: readonly string[];
  scopes: readonly string[];
  authType: 'jwt' | 'api_key';
  isWorkspaceOwner: boolean;
}

export interface KnowledgeAuthInput {
  authorization: string | undefined;
  workspaceId: string | null;
  requestId: string;
  traceId: string;
  consoleSession?: string;
}

export class KnowledgeMockAuthProvider {
  constructor(
    private readonly auth: KnowledgeRuntimeConfig['auth'],
    private readonly environment: KnowledgeRuntimeConfig['environment'],
  ) {}

  async authenticate(input: KnowledgeAuthInput): Promise<KnowledgeSubject> {
    if (this.auth.mode === 'disabled') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_AUTH_REQUIRED',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { reason: 'auth_provider_not_configured' },
      });
    }
    if (this.auth.mode === 'iam') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { provider: 'IAM', status: 'EXTERNAL_UNVERIFIED' },
      });
    }
    if (this.environment === 'production') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_AUTH_REQUIRED',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { reason: 'mock_auth_forbidden_in_production' },
      });
    }
    const session = input.consoleSession
      ? verifyConsoleSession(input.consoleSession, this.auth.fixture.token)
      : null;
    const authorization =
      input.authorization?.startsWith('Bearer ') === true
        ? input.authorization.slice('Bearer '.length).trim()
        : null;
    const expected = Buffer.from(this.auth.fixture.token);
    const actual = Buffer.from(authorization ?? '');
    const tokenMatches =
      authorization !== null &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual);
    if (!tokenMatches && !session) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_AUTH_REQUIRED',
        requestId: input.requestId,
        traceId: input.traceId,
      });
    }
    const workspaceId = input.workspaceId ?? session?.workspaceId ?? null;
    if (!workspaceId || workspaceId !== this.auth.fixture.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: input.requestId,
        traceId: input.traceId,
      });
    }
    return {
      memberId: session?.memberId ?? this.auth.fixture.memberId,
      workspaceIds: [workspaceId],
      scopes: session?.scopes ?? this.auth.fixture.scopes,
      authType: 'jwt',
      isWorkspaceOwner: session?.isWorkspaceOwner ?? this.auth.fixture.isWorkspaceOwner,
    };
  }
}

export function tenantContextOf(
  subject: KnowledgeSubject,
  workspaceId: string,
  requestId: string,
  traceId: string,
): TenantContext {
  return {
    workspaceId,
    memberId: subject.memberId,
    requestId,
    traceId,
    scopes: subject.scopes,
    isWorkspaceOwner: subject.isWorkspaceOwner,
  };
}
