import type { HealthResponse, RouteEntry } from '@kb/contracts';
import type { IdempotencyStore } from '@kb/dal';
import type { FileBinaryResult, S10StatusView } from '@kb/service';
import type { NextApiRequest } from 'next';

export interface KnowledgeAuthSubject {
  authType: 'jwt' | 'api_key';
  memberId: string;
  workspaceIds: readonly string[];
  scopes: readonly string[];
  isWorkspaceOwner?: boolean;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  spaceIds?: readonly string[];
  ipHash?: string;
  userAgentHash?: string;
}

export interface KnowledgeRequestContext {
  subject: KnowledgeAuthSubject;
  workspaceId: string;
  memberId: string;
  scopes: readonly string[];
  requestId: string;
  traceId: string;
}

export interface KnowledgeDispatchInput {
  route: RouteEntry;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | string[] | undefined>>;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  context: KnowledgeRequestContext;
}

export interface KnowledgeDispatchResult {
  status: number;
  data: unknown;
  headers?: Readonly<Record<string, string>>;
  binary?: FileBinaryResult;
  oneTimeSecret?: string;
}

export interface RateLimitDecision {
  limit: number;
  remaining: number;
  resetSeconds: number;
  allowed: boolean;
}

export interface KnowledgeApiRuntime {
  authenticate(
    request: NextApiRequest,
    input: { workspaceId: string | null; requestId: string; traceId: string },
  ): Promise<KnowledgeAuthSubject>;
  ticketWorkspaceId(ticket: string, requestId: string, traceId: string): string;
  idempotencyStore(): Promise<IdempotencyStore>;
  rateLimit(input: {
    workspaceId: string;
    route: RouteEntry;
    requestId: string;
  }): Promise<RateLimitDecision | null>;
  readiness(requestId: string): Promise<{ status: number; body: HealthResponse }>;
  operationsStatus(input: {
    requestId: string;
    traceId: string;
    workspaceId: string;
    memberId: string;
    scopes: readonly string[];
    isWorkspaceOwner: boolean;
    apiKeyId?: string;
    apiKeyPrefix?: string;
    apiKeySpaceIds?: readonly string[];
    ipHash?: string;
    userAgentHash?: string;
  }): Promise<S10StatusView>;
  dispatch(input: KnowledgeDispatchInput): Promise<KnowledgeDispatchResult>;
  log(input: {
    event: string;
    requestId: string;
    traceId: string;
    operationId: string;
    details?: Record<string, unknown>;
  }): void;
}
