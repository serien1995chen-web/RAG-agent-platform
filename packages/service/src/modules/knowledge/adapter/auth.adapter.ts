import { createKnowledgeError } from '@kb/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { KnowledgeRuntimeConfig } from '../../../shared/config/knowledge-runtime-config';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S10ApiKeyRepositoryPort } from '../application/s10-operations.ports';
import {
  effectiveApiKeyStatus,
  hashApiKeySecret,
  hashRequestIdentity,
  isApiKeyUsable,
  matchesApiKeySecretHash,
} from '../domain/s10-api-key';
import { verifyConsoleSession } from './console-session';

export interface KnowledgeSubject {
  memberId: string;
  workspaceIds: readonly string[];
  scopes: readonly string[];
  authType: 'jwt' | 'api_key';
  isWorkspaceOwner: boolean;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  spaceIds?: readonly string[];
  ipHash?: string;
  userAgentHash?: string;
}

export interface KnowledgeAuthInput {
  authorization: string | undefined;
  workspaceId: string | null;
  requestId: string;
  traceId: string;
  consoleSession?: string;
  ipAddress?: string;
  userAgent?: string;
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

function authRequired(input: KnowledgeAuthInput): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_AUTH_REQUIRED',
    requestId: input.requestId,
    traceId: input.traceId,
  });
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export class KnowledgeApiKeyAuthProvider {
  constructor(
    private readonly repository: Pick<
      S10ApiKeyRepositoryPort,
      'findForAuthentication' | 'markUsed'
    >,
    private readonly hmacSecret: string,
  ) {}

  async authenticate(input: KnowledgeAuthInput): Promise<KnowledgeSubject> {
    const token = bearerToken(input.authorization);
    const workspaceId = input.workspaceId?.trim();
    if (!token || !token.startsWith('kn_live_') || !workspaceId) return authRequired(input);
    const now = new Date();
    const lookupContext: TenantContext = {
      workspaceId,
      memberId: 'api-key-auth',
      requestId: input.requestId,
      traceId: input.traceId,
      scopes: [],
      isWorkspaceOwner: false,
    };
    const record = await this.repository.findForAuthentication(
      workspaceId,
      token.slice(0, 12),
      lookupContext,
    );
    if (!record) return authRequired(input);
    const actualHash = hashApiKeySecret(token, this.hmacSecret);
    if (!matchesApiKeySecretHash(record.secretHash, actualHash)) return authRequired(input);
    if (
      !isApiKeyUsable(
        {
          status: record.status,
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
          retireAt: record.retireAt ? new Date(record.retireAt) : null,
        },
        now,
      )
    ) {
      return authRequired(input);
    }
    const status = effectiveApiKeyStatus(
      {
        status: record.status,
        expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
        retireAt: record.retireAt ? new Date(record.retireAt) : null,
      },
      now,
    );
    if (status === 'expired') return authRequired(input);
    const ipHash = hashRequestIdentity(input.ipAddress);
    const userAgentHash = hashRequestIdentity(input.userAgent);
    const context: TenantContext = {
      workspaceId,
      memberId: `api-key:${record.id}`,
      requestId: input.requestId,
      traceId: input.traceId,
      apiKeyId: record.id,
      apiKeyPrefix: record.keyPrefix,
      apiKeySpaceIds: record.spaceIds,
      ipHash,
      userAgentHash,
      scopes: record.scopes,
      isWorkspaceOwner: true,
    };
    await this.repository.markUsed(record.id, now, context);
    return {
      memberId: context.memberId,
      workspaceIds: [workspaceId],
      scopes: record.scopes,
      authType: 'api_key',
      isWorkspaceOwner: true,
      apiKeyId: record.id,
      apiKeyPrefix: record.keyPrefix,
      spaceIds: record.spaceIds,
      ipHash,
      userAgentHash,
    };
  }
}

export class KnowledgeCompositeAuthProvider {
  constructor(
    private readonly jwt: KnowledgeMockAuthProvider,
    private readonly apiKey: KnowledgeApiKeyAuthProvider,
  ) {}

  authenticate(input: KnowledgeAuthInput): Promise<KnowledgeSubject> {
    const token = bearerToken(input.authorization);
    return token?.startsWith('kn_live_')
      ? this.apiKey.authenticate(input)
      : this.jwt.authenticate(input);
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
    ...(subject.apiKeyId ? { apiKeyId: subject.apiKeyId } : {}),
    ...(subject.apiKeyPrefix ? { apiKeyPrefix: subject.apiKeyPrefix } : {}),
    ...(subject.spaceIds ? { apiKeySpaceIds: subject.spaceIds } : {}),
    ...(subject.ipHash ? { ipHash: subject.ipHash } : {}),
    ...(subject.userAgentHash ? { userAgentHash: subject.userAgentHash } : {}),
    scopes: subject.scopes,
    isWorkspaceOwner: subject.isWorkspaceOwner,
  };
}
