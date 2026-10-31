import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { Types, type ClientSession, type Connection } from 'mongoose';
import type { TenantContext } from './tenant';
import { requireWorkspaceId } from './tenant';
import { registerKnowledgeModels } from '../schemas/knowledge-index';
import { withMongoTransaction } from '../with-mongo-transaction';

const SENSITIVE_KEYS = new Set([
  'body',
  'prompt',
  'answer',
  'ip',
  'ipaddress',
  'useragent',
  'objectkey',
]);
const SENSITIVE_KEY_PART = /token|secret|password|credential|authorization|cookie|connection/i;
const MAX_AUDIT_DEPTH = 5;
const MAX_AUDIT_KEYS = 50;
const MAX_AUDIT_ARRAY = 50;

function isSensitiveAuditKey(keyHint: string): boolean {
  const normalized = keyHint.replace(/[-_.\s]/g, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PART.test(keyHint);
}

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

export function safeAuditDiff(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > MAX_AUDIT_DEPTH) return '[REDACTED]';
  if (isSensitiveAuditKey(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_AUDIT_ARRAY).map((entry) => safeAuditDiff(entry, keyHint, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_AUDIT_KEYS)
        .map(([key, entry]) => [key, safeAuditDiff(entry, key, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 512) return '[REDACTED]';
  return value;
}

export class KnowledgeAuditRepository {
  constructor(private readonly connection: Connection) {}

  async appendStandalone(input: KnowledgeAuditInput, context: TenantContext): Promise<void> {
    await withMongoTransaction(this.connection, (session) => this.append(input, context, session));
  }

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
          apiKeyId: context.apiKeyId ? new Types.ObjectId(context.apiKeyId) : null,
          apiKeyPrefix: context.apiKeyPrefix ?? null,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          outcome: input.outcome,
          traceId: context.traceId,
          requestId: context.requestId,
          ipHash: context.ipHash ?? createHash('sha256').update(context.requestId).digest('hex'),
          userAgentHash:
            context.userAgentHash ?? createHash('sha256').update(context.traceId).digest('hex'),
          safeDiff: safeAuditDiff(input.safeDiff) as Record<string, unknown>,
          occurredAt: now,
          expiresAt: new Date(now.getTime() + 730 * 86_400_000),
        },
      ],
      { session, ordered: true },
    );
  }

  async update(): Promise<never> {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_FORBIDDEN',
      requestId: 'audit-append-only',
      traceId: 'audit-append-only',
      details: { reason: 'audit_append_only' },
    });
  }

  async delete(): Promise<never> {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_FORBIDDEN',
      requestId: 'audit-append-only',
      traceId: 'audit-append-only',
      details: { reason: 'audit_append_only' },
    });
  }
}
