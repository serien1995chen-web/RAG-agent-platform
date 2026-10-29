import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { FileBinaryResult } from './ports';
import type { AccessPort } from './ports';
import { stableLogicalIds, validateMappings } from '../domain/s09-synonym';
import type {
  S09SynonymConfigView,
  S09SynonymFileParserPort,
  S09SynonymJobView,
  S09SynonymMappingPage,
  S09SynonymRawFilePort,
  S09SynonymRepositoryPort,
} from './s09-synonym.ports';

export interface S09SynonymFileValue {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface S09SynonymFilePayload {
  file: S09SynonymFileValue;
  enabled?: boolean;
  expectedFileVersion?: number;
}

export interface S09SynonymApplicationDependencies {
  repository: S09SynonymRepositoryPort;
  parser: S09SynonymFileParserPort;
  rawFiles: S09SynonymRawFilePort;
  access: Pick<AccessPort, 'assertPermission'>;
}

function applicationError(
  code: 'KNOWLEDGE_VALIDATION_FAILED' | 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
  context: TenantContext,
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function safeFileName(value: string, context: TenantContext): string {
  const name = [...basename(value.trim().replaceAll('\\', '/'))]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127;
    })
    .join('');
  if (name.length < 1 || name.length > 255) {
    throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'file.name',
      min: 1,
      max: 255,
    });
  }
  return name;
}

function fileVersionOf(
  value: unknown,
  context: TenantContext,
  required = true,
): number | undefined {
  if (value === undefined && !required) return undefined;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'expectedFileVersion',
      min: 1,
    });
  }
  return version;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function synonymRequestHash(input: {
  expectedFileVersion?: number;
  enabled: boolean;
  checksumSha256: string;
  sourceIds: readonly string[];
  reason: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        expectedFileVersion: input.expectedFileVersion ?? null,
        enabled: input.enabled,
        checksumSha256: input.checksumSha256,
        sourceIds: [...input.sourceIds].sort(),
        reason: input.reason,
      }),
    )
    .digest('hex');
}

function quoteCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function serializeCanonicalCsv(
  mappings: ReadonlyArray<{
    standardizedTerm: string;
    synonymTerms: readonly string[];
  }>,
): Buffer {
  const width = Math.max(1, ...mappings.map((mapping) => mapping.synonymTerms.length));
  const header = ['标准词', ...Array.from({ length: width }, (_, index) => `同义词${index + 1}`)];
  const lines = [
    header.map(quoteCsv).join(','),
    ...mappings.map((mapping) =>
      [
        mapping.standardizedTerm,
        ...Array.from({ length: width }, (_, index) => mapping.synonymTerms[index] ?? ''),
      ]
        .map(quoteCsv)
        .join(','),
    ),
  ];
  return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
}

async function binaryOf(bytes: Uint8Array, filename: string): Promise<FileBinaryResult> {
  const buffer = Buffer.from(bytes);
  return {
    body: (async function* () {
      yield buffer;
    })(),
    size: buffer.byteLength,
    etag: createHash('sha256').update(buffer).digest('hex'),
    contentType: 'text/csv; charset=utf-8',
    contentRange: null,
    disposition: 'attachment',
    filename,
  };
}

export class S09SynonymApplication {
  constructor(private readonly input: S09SynonymApplicationDependencies) {}

  private async parseFile(payload: S09SynonymFilePayload, context: TenantContext) {
    const file = payload.file;
    if (!file || typeof file.name !== 'string' || !(file.bytes instanceof Uint8Array)) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: 'file',
        reason: 'binary_file_required',
      });
    }
    const fileName = safeFileName(file.name, context);
    if (file.bytes.byteLength > 10 * 1024 * 1024) {
      throw applicationError('KNOWLEDGE_PAYLOAD_TOO_LARGE', context, {
        field: 'file',
        limitBytes: 10 * 1024 * 1024,
      });
    }
    const parsed = this.input.parser.parse({
      fileName,
      bytes: file.bytes,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const validation = validateMappings(parsed.rows);
    if (!validation.ok) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_SYNONYM_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          diagnostics: validation.diagnostics,
          totalDiagnostics: validation.totalDiagnostics,
          truncated: validation.truncated,
        },
      });
    }
    return {
      fileName,
      mimeType:
        file.mimeType ||
        (parsed.format === 'csv'
          ? 'text/csv'
          : parsed.format === 'xls'
            ? 'application/vnd.ms-excel'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      checksumSha256: sha256(file.bytes),
      validation,
    };
  }

  async get(spaceId: string, context: TenantContext): Promise<S09SynonymConfigView> {
    await this.input.access.assertPermission('space', spaceId, 'read', context);
    return this.input.repository.getConfig(spaceId, context);
  }

  async upload(input: {
    spaceId: string;
    payload: S09SynonymFilePayload;
    idempotencyKey: string;
    context: TenantContext;
    update: boolean;
  }): Promise<{ status: 200 | 201; data: S09SynonymConfigView }> {
    await this.input.access.assertPermission('space', input.spaceId, 'manage', input.context);
    const parsed = await this.parseFile(input.payload, input.context);
    const expectedFileVersion = fileVersionOf(
      input.payload.expectedFileVersion,
      input.context,
      input.update,
    );
    if (input.update && expectedFileVersion === undefined) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', input.context, {
        field: 'expectedFileVersion',
        reason: 'required',
      });
    }
    if (input.payload.enabled !== undefined && typeof input.payload.enabled !== 'boolean') {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', input.context, {
        field: 'enabled',
        reason: 'boolean_required',
      });
    }
    const enabled = input.payload.enabled ?? true;
    const sourceIds = await this.input.repository.listActiveSourceIds(input.spaceId, input.context);
    const mappings = stableLogicalIds({
      workspaceId: input.context.workspaceId,
      knowledgeSpaceId: input.spaceId,
      mappings: parsed.validation.mappings,
    });
    const rawFile = await this.input.rawFiles.store(
      {
        workspaceId: input.context.workspaceId,
        knowledgeSpaceId: input.spaceId,
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        bytes: input.payload.file.bytes,
        sha256: parsed.checksumSha256,
      },
      input.context,
    );
    const result = await this.input.repository.createPendingVersion(
      input.spaceId,
      {
        ...(expectedFileVersion !== undefined ? { expectedFileVersion } : {}),
        enabled,
        reason: 'synonym_change',
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        sizeBytes: input.payload.file.bytes.byteLength,
        checksumSha256: parsed.checksumSha256,
        mappings,
        rawFile,
        sourceIds,
        idempotencyKey: input.idempotencyKey,
        requestHash: synonymRequestHash({
          ...(expectedFileVersion !== undefined ? { expectedFileVersion } : {}),
          enabled,
          checksumSha256: parsed.checksumSha256,
          sourceIds,
          reason: 'synonym_change',
        }),
      },
      input.context,
    );
    return { status: input.update ? 200 : 201, data: result.config };
  }

  async toggle(
    spaceId: string,
    input: { enabled: boolean; version: number },
    context: TenantContext,
  ): Promise<S09SynonymConfigView> {
    await this.input.access.assertPermission('space', spaceId, 'manage', context);
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.version)) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: typeof input.enabled !== 'boolean' ? 'enabled' : 'version',
      });
    }
    return this.input.repository.toggle(spaceId, input, context);
  }

  async delete(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<{ id: string; status: 'disabled'; jobId: null }> {
    await this.input.access.assertPermission('space', spaceId, 'manage', context);
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: 'version',
        min: 1,
      });
    }
    return this.input.repository.disableAndDelete(spaceId, input, context);
  }

  async mappings(
    spaceId: string,
    query: { cursor?: string; limit: number; search?: string },
    context: TenantContext,
  ): Promise<S09SynonymMappingPage> {
    await this.input.access.assertPermission('space', spaceId, 'read', context);
    return this.input.repository.listMappings(spaceId, query, context);
  }

  async download(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
  ): Promise<FileBinaryResult> {
    await this.input.access.assertPermission('space', spaceId, 'read', context);
    if (!Number.isInteger(fileVersion) || fileVersion < 1) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: 'fileVersion',
        min: 1,
      });
    }
    const mappings = await this.input.repository.getMappingSnapshot(spaceId, fileVersion, context);
    if (!mappings) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_NOT_FOUND',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { fileVersion },
      });
    }
    const bytes = serializeCanonicalCsv(
      [...mappings].sort(
        (left, right) =>
          left.normalizedStandardizedTerm.localeCompare(right.normalizedStandardizedTerm) ||
          left.logicalMappingId.localeCompare(right.logicalMappingId),
      ),
    );
    return binaryOf(bytes, `synonyms-v${fileVersion}.csv`);
  }

  async rebuild(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<S09SynonymJobView> {
    await this.input.access.assertPermission('space', spaceId, 'manage', context);
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw applicationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: 'version',
        min: 1,
      });
    }
    return this.input.repository.createManualRebuild(spaceId, input, context);
  }
}
