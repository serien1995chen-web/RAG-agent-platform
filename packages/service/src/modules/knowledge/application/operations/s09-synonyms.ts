import { createKnowledgeError } from '@kb/contracts';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from '../operation-types';
import type { S09SynonymApplication, S09SynonymFilePayload } from '../s09-synonym.application';

export const S09_SYNONYM_OPERATION_IDS = Object.freeze([
  'API-SYNONYM-GET',
  'API-SYNONYM-UPLOAD',
  'API-SYNONYM-UPDATE',
  'API-SYNONYM-DELETE',
  'API-SYNONYM-DOWNLOAD',
  'API-SYNONYM-MAPPINGS',
  'API-SYNONYM-ENABLE',
  'API-SYNONYM-REBUILD',
] as const);

const S09_SYNONYM_OPERATION_SET = new Set<string>(S09_SYNONYM_OPERATION_IDS);

export function isS09SynonymOperation(operationId: string): boolean {
  return S09_SYNONYM_OPERATION_SET.has(operationId);
}

function validation(context: KnowledgeOperationInput['context'], details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function objectBody(input: KnowledgeOperationInput): Record<string, unknown> {
  if (typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) {
    throw validation(input.context, { field: 'body', reason: 'object_required' });
  }
  return input.body as Record<string, unknown>;
}

function versionOf(body: Record<string, unknown>, input: KnowledgeOperationInput): number {
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) {
    throw validation(input.context, { field: 'version', min: 1 });
  }
  return version;
}

function enabledOf(body: Record<string, unknown>, input: KnowledgeOperationInput): boolean {
  if (typeof body.enabled !== 'boolean') {
    throw validation(input.context, { field: 'enabled', reason: 'boolean_required' });
  }
  return body.enabled;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function idempotencyKey(input: KnowledgeOperationInput): string {
  const value = input.headers?.['idempotency-key'] ?? input.headers?.['Idempotency-Key'];
  const key = first(value)?.trim();
  if (!key || key.length < 16 || key.length > 128) {
    throw validation(input.context, {
      header: 'Idempotency-Key',
      reason: 'required_16_128',
    });
  }
  return key;
}

function filePayload(input: KnowledgeOperationInput): S09SynonymFilePayload {
  const body = objectBody(input);
  const file = body.file;
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    throw validation(input.context, { field: 'file', reason: 'object_required' });
  }
  const record = file as Record<string, unknown>;
  if (typeof record.name !== 'string' || !(record.bytes instanceof Uint8Array)) {
    throw validation(input.context, { field: 'file', reason: 'binary_file_required' });
  }
  return {
    file: {
      name: record.name,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : '',
      bytes: record.bytes,
    },
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    ...(body.expectedFileVersion !== undefined
      ? { expectedFileVersion: Number(body.expectedFileVersion) }
      : {}),
  };
}

function spaceId(input: KnowledgeOperationInput): string {
  const value = input.params.spaceId ?? '';
  if (!/^[a-f0-9]{24}$/.test(value)) {
    throw validation(input.context, { field: 'spaceId', reason: 'object_id_required' });
  }
  return value;
}

export class S09SynonymOperationApplication {
  constructor(private readonly application: S09SynonymApplication) {}

  private async download(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const fileVersion = Number(input.params.fileVersion);
    const binary = await this.application.download(spaceId(input), fileVersion, input.context);
    return {
      status: 200,
      data: null,
      binary,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': String(binary.size),
        'Content-Disposition': `attachment; filename="${binary.filename.replaceAll('"', '')}"`,
      },
    };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (!isS09SynonymOperation(input.operationId)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { operationId: input.operationId, application: 's09-synonym' },
      });
    }
    if (input.operationId === 'API-SYNONYM-GET') {
      return {
        status: 200,
        data: await this.application.get(spaceId(input), input.context),
      };
    }
    if (input.operationId === 'API-SYNONYM-UPLOAD' || input.operationId === 'API-SYNONYM-UPDATE') {
      return this.application.upload({
        spaceId: spaceId(input),
        payload: filePayload(input),
        idempotencyKey: idempotencyKey(input),
        context: input.context,
        update: input.operationId === 'API-SYNONYM-UPDATE',
      });
    }
    if (input.operationId === 'API-SYNONYM-ENABLE') {
      const body = objectBody(input);
      idempotencyKey(input);
      return {
        status: 200,
        data: await this.application.toggle(
          spaceId(input),
          { enabled: enabledOf(body, input), version: versionOf(body, input) },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-SYNONYM-DELETE') {
      const body = objectBody(input);
      idempotencyKey(input);
      return {
        status: 202,
        data: await this.application.delete(
          spaceId(input),
          { version: versionOf(body, input) },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-SYNONYM-DOWNLOAD') {
      return this.download(input);
    }
    if (input.operationId === 'API-SYNONYM-MAPPINGS') {
      const limitValue = first(input.query.limit);
      const limit = limitValue === undefined ? 50 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw validation(input.context, { field: 'limit', min: 1, max: 200 });
      }
      const search = first(input.query.search)?.trim();
      if (search && search.length > 128) {
        throw validation(input.context, { field: 'search', maxLength: 128 });
      }
      return {
        status: 200,
        data: await this.application.mappings(
          spaceId(input),
          {
            limit,
            ...(first(input.query.cursor) ? { cursor: first(input.query.cursor)! } : {}),
            ...(search ? { search } : {}),
          },
          input.context,
        ),
      };
    }
    if (input.operationId === 'API-SYNONYM-REBUILD') {
      const body = objectBody(input);
      idempotencyKey(input);
      return {
        status: 202,
        data: await this.application.rebuild(
          spaceId(input),
          { version: versionOf(body, input) },
          input.context,
        ),
      };
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId },
    });
  }
}
