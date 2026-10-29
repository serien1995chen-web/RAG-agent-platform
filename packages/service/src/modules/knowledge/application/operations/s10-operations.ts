import { createKnowledgeError } from '@kb/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from '../operation-types';
import type {
  S10ApiKeyRepositoryPort,
  S10AuditQueryPort,
  S10OpsRepositoryPort,
  S10UsageRepositoryPort,
} from '../s10-operations.ports';
import {
  defaultApiKeyExpiry,
  generateApiKeySecret,
  hashApiKeySecret,
  isWorkspaceWideApiKey,
  validateApiKeyScopes,
} from '../../domain/s10-api-key';

export const S10_OPERATION_IDS = Object.freeze([
  'API-APIKEY-LIST',
  'API-APIKEY-CREATE',
  'API-APIKEY-UPDATE',
  'API-APIKEY-DELETE',
  'API-APIKEY-ROTATE',
  'API-USAGE-GET',
  'API-AUDIT-LIST',
  'API-OPS-CLEANUP',
  'API-OPS-RECONCILE',
  'API-OPS-OUTBOX-REPLAY',
] as const);

const S10_OPERATION_SET = new Set<string>(S10_OPERATION_IDS);

export function isS10Operation(operationId: string): boolean {
  return S10_OPERATION_SET.has(operationId);
}

const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.string()).min(1),
    spaceIds: z.array(z.string()).default([]),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const UpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(z.string()).min(1).optional(),
    spaceIds: z.array(z.string()).optional(),
    status: z.enum(['active', 'revoked']).optional(),
    version: z.number().int().min(1),
  })
  .strict();

const VersionSchema = z.object({ version: z.number().int().min(1) }).strict();
const CleanupSchema = z
  .object({
    scope: z.enum(['ttl_objects', 'orphan_objects', 'orphan_vectors', 'stale_jobs', 'all']),
  })
  .strict();
const ReconcileSchema = z
  .object({
    scope: z.enum(['objects', 'vectors', 'fulltext', 'outbox', 'all']),
    repair: z.boolean().default(false),
  })
  .strict();

function validation(context: TenantContext, details: Record<string, unknown>): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, context: TenantContext): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
    });
  }
  return parsed.data;
}

function firstQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = query[name];
  return Array.isArray(value) ? value[0] : value;
}

function expectedVersionQuery(input: KnowledgeOperationInput): number {
  const value = Number(firstQuery(input.query, 'expectedVersion'));
  if (!Number.isInteger(value) || value < 1) {
    return validation(input.context, {
      field: 'expectedVersion',
      reason: 'required_positive_integer',
    });
  }
  return value;
}

function header(input: KnowledgeOperationInput, name: string): string | undefined {
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function idempotencyKey(input: KnowledgeOperationInput): string {
  const value = header(input, 'idempotency-key')?.trim();
  if (!value || value.length < 16 || value.length > 128) {
    return validation(input.context, {
      header: 'Idempotency-Key',
      reason: 'required 16-128 characters',
    });
  }
  return value;
}

export interface S10OperationDependencies {
  apiKeys: S10ApiKeyRepositoryPort;
  usage: S10UsageRepositoryPort;
  audits: S10AuditQueryPort;
  ops: S10OpsRepositoryPort;
  catalog: { getSpace(spaceId: string, context: TenantContext): Promise<unknown> };
  hmacSecret: string;
  now?: () => Date;
}

export class S10OperationApplication {
  constructor(private readonly input: S10OperationDependencies) {}

  private assertWorkspaceWideAdmin(context: TenantContext): void {
    if (!context.scopes.includes('knowledge:admin')) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { scope: 'knowledge:admin' },
      });
    }
    if (context.apiKeySpaceIds && !isWorkspaceWideApiKey(context.apiKeySpaceIds)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'workspace_wide_api_key_required' },
      });
    }
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    this.assertWorkspaceWideAdmin(input.context);
    if (input.operationId === 'API-APIKEY-LIST') {
      const limitValue = firstQuery(input.query, 'limit');
      const limit = limitValue === undefined ? undefined : Number(limitValue);
      const page = await this.input.apiKeys.list(
        {
          ...(firstQuery(input.query, 'cursor')
            ? { cursor: firstQuery(input.query, 'cursor')! }
            : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(firstQuery(input.query, 'sort') ? { sort: firstQuery(input.query, 'sort') } : {}),
        },
        input.context,
      );
      return { status: 200, data: page };
    }
    if (input.operationId === 'API-APIKEY-CREATE') {
      const body = parse(CreateSchema, input.body ?? {}, input.context);
      const scopes = validateApiKeyScopes(body.scopes, input.context);
      const now = this.input.now?.() ?? new Date();
      const expiresAt = body.expiresAt
        ? new Date(body.expiresAt)
        : defaultApiKeyExpiry(scopes, now);
      const generated = generateApiKeySecret();
      const record = await this.input.apiKeys.create(
        {
          name: body.name,
          scopes,
          spaceIds: body.spaceIds,
          expiresAt,
        },
        {
          keyPrefix: generated.prefix,
          secretHash: hashApiKeySecret(generated.secret, this.input.hmacSecret),
        },
        input.context,
      );
      return { status: 201, data: record, oneTimeSecret: generated.secret };
    }
    if (input.operationId === 'API-APIKEY-UPDATE') {
      const body = parse(UpdateSchema, input.body ?? {}, input.context);
      if (Object.keys(body).filter((key) => key !== 'version').length === 0) {
        return validation(input.context, { field: 'body', reason: 'mutable_field_required' });
      }
      const scopes =
        body.scopes === undefined ? undefined : validateApiKeyScopes(body.scopes, input.context);
      return {
        status: 200,
        data: await this.input.apiKeys.update(
          input.params.keyId ?? '',
          {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(scopes !== undefined ? { scopes } : {}),
            ...(body.spaceIds !== undefined ? { spaceIds: body.spaceIds } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            version: body.version,
          },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-APIKEY-DELETE') {
      await this.input.apiKeys.revoke(
        input.params.keyId ?? '',
        expectedVersionQuery(input),
        input.context,
      );
      return { status: 204, data: undefined };
    }
    if (input.operationId === 'API-APIKEY-ROTATE') {
      const body = parse(VersionSchema, input.body ?? {}, input.context);
      const generated = generateApiKeySecret();
      const record = await this.input.apiKeys.rotate(
        input.params.keyId ?? '',
        body.version,
        {
          keyPrefix: generated.prefix,
          secretHash: hashApiKeySecret(generated.secret, this.input.hmacSecret),
        },
        input.context,
      );
      return { status: 200, data: record, oneTimeSecret: generated.secret };
    }
    if (input.operationId === 'API-USAGE-GET') {
      const now = this.input.now?.() ?? new Date();
      const fromValue = firstQuery(input.query, 'from');
      const toValue = firstQuery(input.query, 'to');
      const from = fromValue ? new Date(fromValue) : new Date(now.getTime() - 30 * 86_400_000);
      const to = toValue ? new Date(toValue) : now;
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        return validation(input.context, {
          field: 'period',
          reason: 'invalid_or_reversed',
        });
      }
      if (to.getTime() - from.getTime() > 366 * 86_400_000) {
        return validation(input.context, { field: 'period', maxDays: 366 });
      }
      const typeValue = firstQuery(input.query, 'type');
      const type = typeValue as
        | 'parse'
        | 'ocr'
        | 'embedding'
        | 'rerank'
        | 'llm'
        | 'vlm'
        | 'stt'
        | 'tts'
        | 'storage'
        | 'sync'
        | undefined;
      if (
        type &&
        ![
          'parse',
          'ocr',
          'embedding',
          'rerank',
          'llm',
          'vlm',
          'stt',
          'tts',
          'storage',
          'sync',
        ].includes(type)
      ) {
        return validation(input.context, { field: 'type', reason: 'unsupported' });
      }
      const spaceId = firstQuery(input.query, 'spaceId');
      if (spaceId) await this.input.catalog.getSpace(spaceId, input.context);
      return {
        status: 200,
        data: await this.input.usage.summary(
          {
            from,
            to,
            ...(type ? { type } : {}),
            ...(spaceId ? { spaceId } : {}),
          },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-AUDIT-LIST') {
      const fromValue = firstQuery(input.query, 'from');
      const toValue = firstQuery(input.query, 'to');
      const from = fromValue ? new Date(fromValue) : undefined;
      const to = toValue ? new Date(toValue) : undefined;
      if (
        (from && Number.isNaN(from.getTime())) ||
        (to && Number.isNaN(to.getTime())) ||
        (from && to && from > to)
      ) {
        return validation(input.context, { field: 'period', reason: 'invalid_or_reversed' });
      }
      if (from && to && to.getTime() - from.getTime() > 90 * 86_400_000) {
        return validation(input.context, { field: 'period', maxDays: 90 });
      }
      const outcome = firstQuery(input.query, 'outcome');
      if (outcome && !['allowed', 'denied', 'succeeded', 'failed'].includes(outcome)) {
        return validation(input.context, { field: 'outcome', reason: 'unsupported' });
      }
      const limitValue = firstQuery(input.query, 'limit');
      return {
        status: 200,
        data: await this.input.audits.list(
          {
            ...(firstQuery(input.query, 'cursor')
              ? { cursor: firstQuery(input.query, 'cursor')! }
              : {}),
            ...(limitValue ? { limit: Number(limitValue) } : {}),
            ...(firstQuery(input.query, 'action')
              ? { action: firstQuery(input.query, 'action')! }
              : {}),
            ...(firstQuery(input.query, 'actor')
              ? { actor: firstQuery(input.query, 'actor')! }
              : {}),
            ...(firstQuery(input.query, 'resourceType')
              ? { resourceType: firstQuery(input.query, 'resourceType')! }
              : {}),
            ...(firstQuery(input.query, 'resourceId')
              ? { resourceId: firstQuery(input.query, 'resourceId')! }
              : {}),
            ...(outcome
              ? { outcome: outcome as 'allowed' | 'denied' | 'succeeded' | 'failed' }
              : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-OPS-CLEANUP') {
      const body = parse(CleanupSchema, input.body ?? {}, input.context);
      return {
        status: 202,
        data: await this.input.ops.createCleanupJob(
          { scope: body.scope, idempotencyKey: idempotencyKey(input) },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-OPS-RECONCILE') {
      const body = parse(ReconcileSchema, input.body ?? {}, input.context);
      return {
        status: 202,
        data: await this.input.ops.createReconcileJob(
          {
            scope: body.scope,
            repair: body.repair,
            idempotencyKey: idempotencyKey(input),
          },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-OPS-OUTBOX-REPLAY') {
      const body = parse(VersionSchema, input.body ?? {}, input.context);
      return {
        status: 200,
        data: await this.input.ops.replayOutbox(
          {
            eventId: input.params.eventId ?? '',
            version: body.version,
            idempotencyKey: idempotencyKey(input),
          },
          input.context,
        ),
      };
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, reason: 's10_operation_not_wired' },
    });
  }
}
