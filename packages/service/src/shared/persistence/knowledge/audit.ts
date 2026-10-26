import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Connection } from 'mongoose';
import type { TenantContext } from './tenant';
import { requireWorkspaceId } from './tenant';
import { registerKnowledgeModels } from '../schemas/knowledge-index';

const SENSITIVE_KEY = /token|secret|password|credential|authorization|cookie|objectKey/i;

export interface KnowledgeAuditInput {
  knowledgeSpaceId: string | null;
  action: string;
  resourceType:
    | 'workspace'
    | 'space'
    | 'directory'
    | 'source'
    | 'segment'
    | 'job'
    | 'connector'
    | 'api_key';
  resourceId: string;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  safeDiff: Record<string, unknown>;
}

export function safeAuditDiff(value: unknown, keyHint = ''): unknown {
  if (SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) {
    return value.map((entry) => safeAuditDiff(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        safeAuditDiff(entry, key),
      ]),
    );
  }
  return value;
}

export class KnowledgeAuditRepository {
  constructor(private readonly connection: Connection) {}

  async append(
    input: KnowledgeAuditInput,
    context: TenantContext,
    session: ClientSession,
  ): Promise<void> {
    const workspaceId = requireWorkspaceId(context);
    const models = registerKnowledgeModels(this.connection);
    const now = new Date();
    await models.KnowledgeAuditEvent.create(
      [
        {
          workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          eventId: randomUUID(),
          action: input.action,
          actorMemberId: context.memberId,
          apiKeyId: null,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          outcome: input.outcome,
          traceId: context.traceId,
          requestId: context.requestId,
          ipHash: createHash('sha256').update(context.requestId).digest('hex'),
          userAgentHash: createHash('sha256').update(context.traceId).digest('hex'),
          safeDiff: safeAuditDiff(input.safeDiff) as Record<string, unknown>,
          occurredAt: now,
          expiresAt: new Date(now.getTime() + 730 * 86_400_000),
        },
      ],
      { session, ordered: true },
    );
  }
}
