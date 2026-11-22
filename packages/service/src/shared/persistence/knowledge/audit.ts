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

export const KNOWLEDGE_AUDIT_RESOURCE_TYPES = Object.freeze([
  'workspace',
  'space',
  'directory',
  'source',
  'segment',
  'job',
  'connector',
  'api_key',
  'file',
  'tag',
  'synonym',
] as const);

export type KnowledgeAuditResourceType = (typeof KNOWLEDGE_AUDIT_RESOURCE_TYPES)[number];

export const KNOWLEDGE_AUDIT_ACTIONS = Object.freeze([
  'acl.resume',
  'acl.update',
  'api_key.create',
  'api_key.list',
  'api_key.revoke',
  'api_key.rotate',
  'api_key.update',
  'batch.source.failed',
  'cleanup.queued',
  'collaborator.create',
  'collaborator.delete',
  'collaborator.update',
  'connector.connect',
  'connector.delete',
  'connector.sync',
  'connector.update',
  'delete',
  'directory.create',
  'directory.delete',
  'directory.move',
  'directory.update',
  'export.create',
  'file.ticket.issue',
  'import.files.submit',
  'knowledge.search',
  'knowledge.search.deep.round',
  'model.invoke',
  'move',
  'ocr.invoke',
  'ownership.transfer',
  'reference.remove',
  'reference.upsert',
  'reindex',
  'retry',
  'segment.create',
  'source.create',
  'source.delete',
  'source.move',
  'source.update',
  'space.create',
  'space.delete',
  'space.model_bindings.update',
  'space.move',
  'space.update',
  'synonym.config.delete',
  'synonym.config.toggle',
  'synonym.file.upload',
  'synonym.rebuild.complete',
  'synonym.rebuild.failed',
  'synonym.rebuild.request',
  'tag.create',
  'tag.delete',
  'tag.update',
  'upsert',
] as const);

export type KnowledgeAuditAction = (typeof KNOWLEDGE_AUDIT_ACTIONS)[number];

export function isKnowledgeAuditAction(value: string): boolean {
  return (
    (KNOWLEDGE_AUDIT_ACTIONS as readonly string[]).includes(value) ||
    /^API-[A-Z0-9-]+\.denied$/.test(value)
  );
}

export function isKnowledgeAuditResourceType(value: string): value is KnowledgeAuditResourceType {
  return (KNOWLEDGE_AUDIT_RESOURCE_TYPES as readonly string[]).includes(value);
}

function isSensitiveAuditKey(keyHint: string): boolean {
  const normalized = keyHint.replace(/[-_.\s]/g, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PART.test(keyHint);
}

export interface KnowledgeAuditInput {
  knowledgeSpaceId: string | null;
  action: KnowledgeAuditAction | (string & {});
  resourceType: KnowledgeAuditResourceType;
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
