import {
  ConnectorCatalogRequestSchema,
  ConnectorConnectSchema,
  ConnectorImportSchema,
  ConnectorSyncSchema,
  ConnectorUpdateSchema,
  ImportApiLibrarySchema,
  ImportBackupSchema,
  ImportFilesSchema,
  ImportTemplateSchema,
  ImportTextSchema,
  ImportUrlSchema,
  createKnowledgeError,
} from '@kb/contracts';
import type { QueuePort } from '@kb/dal';
import { z } from 'zod';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type {
  CloudConnectorProvider,
  CloudProviderClientPort,
  ConnectorProvider,
  CustomApiClientPort,
  ImportSourceDraft,
  ImportSubmissionCommand,
  ImportSubmissionResult,
  IngestionContentResult,
  IngestionContentPort,
  ImportPlanningPort,
  ScopedAuthPort,
  UrlImportAdapterPort,
  ImportTemplateParserPort,
  QuotaGatePort,
} from '../ingestion.ports';
import type { ConnectorRepositoryPort } from '../ingestion.ports';
import type { AccessPort, ObjectRefRepositoryPort } from '../ports';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from '../knowledge.application';
import {
  assertNonEmptyText,
  assertUniqueIds,
  requestHashOf,
  sha256Of,
} from '../../domain/import-submission';
import { assertS8ImageCount, isS8KnowledgeImage } from '../s8-image-policy';

type ImportRepository = ImportPlanningPort;
type ConnectorRepository = ConnectorRepositoryPort;

export interface S04IngestionDependencies {
  imports: ImportRepository;
  connectors: ConnectorRepository;
  objectRefs: Pick<ObjectRefRepositoryPort, 'findObjectRef'>;
  content: IngestionContentPort;
  urlImport: UrlImportAdapterPort;
  customApi: CustomApiClientPort;
  providers: Readonly<Record<CloudConnectorProvider, CloudProviderClientPort>>;
  access: AccessPort;
  scopedAuth: ScopedAuthPort;
  quotaGate: QuotaGatePort;
  templateParser: ImportTemplateParserPort;
  queuePort?: QueuePort;
}

export class FixtureScopedAuthPort implements ScopedAuthPort {
  async authorize(input: {
    subject: {
      authType: 'jwt' | 'api_key';
      memberId: string;
      workspaceIds: readonly string[];
      scopes: readonly string[];
    };
    workspaceId: string;
    knowledgeSpaceId: string;
    requiredScope: 'knowledge:write';
  }): Promise<void> {
    if (
      !input.subject.workspaceIds.includes(input.workspaceId) ||
      (!input.subject.scopes.includes(input.requiredScope) &&
        !input.subject.scopes.includes('knowledge:admin'))
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: 'scoped-auth',
        traceId: 'scoped-auth',
        details: { requiredScope: input.requiredScope },
      });
    }
  }
}

export class FixtureQuotaGatePort implements QuotaGatePort {
  async check(): Promise<void> {
    return undefined;
  }
}

function headerValue(input: KnowledgeOperationInput, name: string): string | undefined {
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function idempotencyKey(input: KnowledgeOperationInput): string {
  const value = headerValue(input, 'idempotency-key')?.trim();
  if (!value || value.length < 16 || value.length > 128) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: {
        header: 'Idempotency-Key',
        reason: 'required and must be 16-128 characters',
      },
    });
  }
  return value;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, input: KnowledgeOperationInput): z.infer<T> {
  const result = schema.safeParse(input.body ?? {});
  if (!result.success) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

function spaceId(input: KnowledgeOperationInput): string {
  const value = input.params.spaceId;
  if (!value) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { field: 'spaceId', reason: 'required' },
    });
  }
  return value;
}

function operationHash(input: KnowledgeOperationInput): string {
  return requestHashOf({
    operationId: input.operationId,
    workspaceId: input.context.workspaceId,
    params: input.params,
    body: input.body ?? null,
  });
}

function configurationHash(input: {
  parseConfig?: unknown;
  chunking?: unknown;
  qa?: unknown;
}): string {
  return requestHashOf({
    parseConfig: input.parseConfig ?? {},
    chunking: input.chunking ?? {},
    qa: input.qa ?? {},
  });
}

function connectorProvider(value: string | undefined, context: TenantContext): ConnectorProvider {
  if (value === 'custom_api' || value === 'feishu' || value === 'yuque' || value === 'dingtalk') {
    return value;
  }
  throw createKnowledgeError({
    code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { field: 'provider', reason: 'unsupported_provider' },
  });
}

function cloudProvider(value: string | undefined, context: TenantContext): CloudConnectorProvider {
  const provider = connectorProvider(value, context);
  if (provider === 'custom_api') {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { provider, reason: 'cloud_provider_required' },
    });
  }
  return provider;
}

function assertProviderIdentity(input: {
  pathProvider: ConnectorProvider;
  configProvider: unknown;
  credentialsProvider: unknown;
  bodyProvider?: unknown;
  context: TenantContext;
}): void {
  if (
    input.configProvider !== input.pathProvider ||
    input.credentialsProvider !== input.pathProvider ||
    (input.bodyProvider !== undefined && input.bodyProvider !== input.pathProvider)
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { provider: input.pathProvider, reason: 'provider_mismatch' },
    });
  }
}

async function assertWriteAccess(
  dependencies: S04IngestionDependencies,
  knowledgeSpaceId: string,
  context: TenantContext,
): Promise<void> {
  await dependencies.access.assertPermission('space', knowledgeSpaceId, 'write', context);
  await dependencies.scopedAuth.authorize({
    subject: {
      authType: 'jwt',
      memberId: context.memberId,
      workspaceIds: [context.workspaceId],
      scopes: context.scopes,
    },
    workspaceId: context.workspaceId,
    knowledgeSpaceId,
    requiredScope: 'knowledge:write',
  });
}

async function assertSpaceAccess(
  dependencies: S04IngestionDependencies,
  knowledgeSpaceId: string,
  level: 'read' | 'write' | 'manage',
  context: TenantContext,
): Promise<void> {
  await dependencies.access.assertPermission('space', knowledgeSpaceId, level, context);
}

async function compensate(
  dependencies: S04IngestionDependencies,
  materials: readonly IngestionContentResult[],
  knowledgeSpaceId: string,
  context: TenantContext,
): Promise<void> {
  await Promise.all(
    materials.map((material) =>
      material.createdObjectKey
        ? dependencies.content.compensate(material.createdObjectKey, knowledgeSpaceId, context)
        : Promise.resolve(),
    ),
  );
}

function commandOf(input: {
  operation: KnowledgeOperationInput;
  knowledgeSpaceId: string;
  directoryId: string | null;
  importKind: ImportSubmissionCommand['importKind'];
  sources: readonly ImportSourceDraft[];
  parseConfig?: Record<string, unknown>;
  chunking?: Record<string, unknown>;
  qaConfig?: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  dryRun?: boolean;
  conflictStrategy?: 'fail' | 'skip' | 'overwrite';
}): ImportSubmissionCommand {
  return {
    workspaceId: input.operation.context.workspaceId,
    knowledgeSpaceId: input.knowledgeSpaceId,
    directoryId: input.directoryId,
    importKind: input.importKind,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    configurationHash: configurationHash({
      parseConfig: input.parseConfig,
      chunking: input.chunking,
      qa: input.qaConfig,
    }),
    sourceDrafts: input.sources,
    parseConfigSnapshot: input.parseConfig ?? {},
    chunkingConfigSnapshot: input.chunking ?? {},
    qaConfigSnapshot: input.qaConfig ?? {},
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.conflictStrategy ? { conflictStrategy: input.conflictStrategy } : {}),
  };
}

async function preflightImport(input: {
  dependencies: S04IngestionDependencies;
  operation: KnowledgeOperationInput;
  knowledgeSpaceId: string;
  importKind: ImportSubmissionCommand['importKind'];
  idempotencyKey: string;
  requestHash: string;
}): Promise<ImportSubmissionResult | null> {
  return input.dependencies.imports.preflight(
    {
      workspaceId: input.operation.context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      directoryId: null,
      importKind: input.importKind,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      configurationHash: '',
      sourceDrafts: [],
      parseConfigSnapshot: {},
      chunkingConfigSnapshot: {},
      qaConfigSnapshot: {},
    },
    input.operation.context,
  );
}

async function assertQuota(
  dependencies: S04IngestionDependencies,
  input: {
    operation: 'import' | 'sync';
    knowledgeSpaceId: string;
    sourceCount: number;
    sizeBytes: number;
    context: TenantContext;
  },
): Promise<void> {
  await dependencies.quotaGate.check(
    {
      operation: input.operation,
      workspaceId: input.context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceCount: input.sourceCount,
      sizeBytes: input.sizeBytes,
    },
    input.context,
  );
}

async function fileDrafts(
  dependencies: S04IngestionDependencies,
  input: KnowledgeOperationInput,
  ids: readonly string[],
  targetSpaceId: string,
  directoryId: string | null,
  parseProvider: ImportSourceDraft['parseProvider'],
): Promise<ImportSourceDraft[]> {
  const drafts: ImportSourceDraft[] = [];
  let imageCount = 0;
  for (const uploadId of assertUniqueIds(ids, 'uploadIds', input.context)) {
    const object = await dependencies.objectRefs.findObjectRef(uploadId, input.context);
    if (
      !object ||
      object.state !== 'active' ||
      object.purpose !== 'source' ||
      object.sourceId !== null ||
      object.knowledgeSpaceId !== targetSpaceId ||
      object.uploadStatus !== 'completed'
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_NOT_FOUND',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { field: 'uploadIds', uploadId },
      });
    }
    if (
      isS8KnowledgeImage({
        mimeType: object.mimeType,
        fileName: object.originalName,
      })
    ) {
      imageCount += 1;
      assertS8ImageCount(imageCount, input.context);
    }
    drafts.push(
      dependencies.content.fileDraft({
        object,
        directoryId,
        parseProvider,
      }),
    );
  }
  if (drafts.length > 0 && imageCount === drafts.length) {
    assertS8ImageCount(imageCount, input.context);
  }
  return drafts;
}

function backupExternalId(question: string, answer: string): string {
  return `backup:${sha256Of(`${question}\u0000${answer}`)}`;
}

export class S04IngestionApplication {
  constructor(private readonly dependencies: S04IngestionDependencies) {}

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    switch (input.operationId) {
      case 'API-IMPORT-FILES': {
        const body = parseBody(ImportFilesSchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'files',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: body.uploadIds.length,
          sizeBytes: 0,
          context: input.context,
        });
        const sources = await fileDrafts(
          this.dependencies,
          input,
          body.uploadIds,
          targetSpaceId,
          body.directoryId ?? null,
          body.parseProvider,
        );
        const result = await this.dependencies.imports.submit(
          commandOf({
            operation: input,
            knowledgeSpaceId: targetSpaceId,
            directoryId: body.directoryId ?? null,
            importKind: 'files',
            sources,
            parseConfig: body.parseConfig,
            chunking: body.chunking as Record<string, unknown>,
            idempotencyKey: idempotency,
            requestHash,
          }),
          input.context,
        );
        return { status: 202, data: result.job };
      }
      case 'API-IMPORT-TEXT': {
        const body = parseBody(ImportTextSchema, input);
        const targetSpaceId = spaceId(input);
        if (body.knowledgeSpaceId !== targetSpaceId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'knowledgeSpaceId', reason: 'path_body_mismatch' },
          });
        }
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const text = assertNonEmptyText(body.text, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'text',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: 1,
          sizeBytes: Buffer.byteLength(text, 'utf8'),
          context: input.context,
        });
        const material = await this.dependencies.content.materializeText({
          knowledgeSpaceId: targetSpaceId,
          directoryId: body.directoryId ?? null,
          name: body.name,
          text,
          context: input.context,
        });
        try {
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: 'text',
              sources: [material.source],
              chunking: body.chunking as Record<string, unknown>,
              idempotencyKey: idempotency,
              requestHash,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, [material], targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, [material], targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-IMPORT-URL': {
        const body = parseBody(ImportUrlSchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'url',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: 1,
          sizeBytes: 0,
          context: input.context,
        });
        const snapshot = await this.dependencies.urlImport.fetch({
          url: body.url,
          selector: body.selector,
          context: input.context,
        });
        const material = await this.dependencies.content.materializeUrl({
          knowledgeSpaceId: targetSpaceId,
          directoryId: body.directoryId ?? null,
          selector: body.selector,
          snapshot,
          context: input.context,
        });
        try {
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: 'url',
              sources: [material.source],
              idempotencyKey: idempotency,
              requestHash,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, [material], targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, [material], targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-IMPORT-TEMPLATE': {
        const body = parseBody(ImportTemplateSchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'template',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        const upload = await this.dependencies.objectRefs.findObjectRef(
          body.uploadId,
          input.context,
        );
        if (
          !upload ||
          upload.knowledgeSpaceId !== targetSpaceId ||
          upload.state !== 'active' ||
          upload.purpose !== 'source'
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'uploadId' },
          });
        }
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: 1,
          sizeBytes: upload.sizeBytes,
          context: input.context,
        });
        const bytes = await this.dependencies.content.readObjectBytes({
          ref: upload,
          knowledgeSpaceId: targetSpaceId,
          maxBytes: 50 * 1024 * 1024,
          context: input.context,
        });
        const parsed = this.dependencies.templateParser.parse({
          fileName: upload.originalName,
          mimeType: upload.mimeType,
          bytes,
          backup: false,
          requestId: input.context.requestId,
          traceId: input.context.traceId,
        });
        const material = await this.dependencies.content.materializeTemplate({
          knowledgeSpaceId: targetSpaceId,
          directoryId: body.directoryId ?? null,
          name: upload.originalName,
          mimeType: upload.mimeType,
          bytes,
          rows: parsed.rows.length,
          backup: false,
          context: input.context,
        });
        try {
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: 'template',
              sources: [material.source],
              chunking: { trainingType: 'template', chunkSettingMode: 'auto' },
              idempotencyKey: idempotency,
              requestHash,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, [material], targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, [material], targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-IMPORT-BACKUP': {
        const body = parseBody(ImportBackupSchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'backup',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        const upload = await this.dependencies.objectRefs.findObjectRef(
          body.uploadId,
          input.context,
        );
        if (
          !upload ||
          upload.knowledgeSpaceId !== targetSpaceId ||
          upload.state !== 'active' ||
          upload.purpose !== 'source'
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'uploadId' },
          });
        }
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: 1,
          sizeBytes: upload.sizeBytes,
          context: input.context,
        });
        const bytes = await this.dependencies.content.readObjectBytes({
          ref: upload,
          knowledgeSpaceId: targetSpaceId,
          maxBytes: 50 * 1024 * 1024,
          context: input.context,
        });
        const parsed = this.dependencies.templateParser.parse({
          fileName: upload.originalName,
          mimeType: upload.mimeType,
          bytes,
          backup: true,
          requestId: input.context.requestId,
          traceId: input.context.traceId,
        });
        const externalIds = parsed.rows.map((row) => backupExternalId(row.question, row.answer));
        const conflicts = (
          await this.dependencies.imports.backupConflicts(targetSpaceId, externalIds, input.context)
        ).map((conflict) => ({
          ...conflict,
          rowNumber:
            parsed.rows.find(
              (row) => backupExternalId(row.question, row.answer) === conflict.externalId,
            )?.rowNumber ?? conflict.rowNumber,
        }));
        const actions = conflicts.map((conflict) => ({
          rowNumber: conflict.rowNumber,
          action: body.conflictStrategy,
        }));
        if (
          body.dryRun ||
          (body.conflictStrategy === 'skip' && parsed.rows.length === conflicts.length)
        ) {
          const plan = await this.dependencies.imports.createDryRunJob(
            {
              knowledgeSpaceId: targetSpaceId,
              idempotencyKey: idempotency,
              requestHash,
              configurationHash: configurationHash({}),
              importKind: 'backup',
              dryRun: body.dryRun,
              conflicts,
              actions,
            },
            input.context,
          );
          return { status: 202, data: plan.job };
        }
        if (body.conflictStrategy === 'fail' && conflicts.length > 0) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { conflicts },
          });
        }
        const conflictByExternalId = new Map(
          conflicts.map((conflict) => [conflict.externalId, conflict]),
        );
        const materials: IngestionContentResult[] = [];
        try {
          for (const row of parsed.rows) {
            const externalId = backupExternalId(row.question, row.answer);
            const conflict = conflictByExternalId.get(externalId);
            if (body.conflictStrategy === 'skip' && conflict) continue;
            const material = await this.dependencies.content.materialize({
              kind: 'backup',
              name: row.question.slice(0, 240),
              mimeType: 'text/plain; charset=utf-8',
              bytes: Buffer.from(`${row.question}\n\n${row.answer}`, 'utf8'),
              directoryId: body.directoryId ?? null,
              parseProvider: 'liteparse',
              metadata: {
                rowNumber: row.rowNumber,
                question: row.question,
                answer: row.answer,
                indexes: row.indexes,
                backupMetadata: row.metadata,
                schemaVersion: 1,
              },
              context: input.context,
              knowledgeSpaceId: targetSpaceId,
              externalId,
            });
            if (conflict && body.conflictStrategy === 'overwrite') {
              material.source.id = conflict.existingSourceId;
              material.source.replaceSourceId = conflict.existingSourceId;
              material.source.replaceSourceVersion = conflict.existingVersion;
            }
            materials.push(material);
          }
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: 'backup',
              sources: materials.map((material) => material.source),
              chunking: { trainingType: 'backup', chunkSettingMode: 'auto' },
              idempotencyKey: idempotency,
              requestHash,
              dryRun: false,
              conflictStrategy: body.conflictStrategy,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, materials, targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, materials, targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-IMPORT-API-CATALOG': {
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const body = parseBody(
          z.object({
            config: z.record(z.string(), z.unknown()),
            credentials: z.record(z.string(), z.unknown()),
            parentId: z.string().default(''),
            cursor: z.string().optional(),
            offset: z.number().int().min(0).optional(),
          }),
          input,
        );
        return {
          status: 200,
          data: await this.dependencies.customApi.catalog({
            config: body.config,
            credentials: body.credentials,
            parentId: body.parentId,
            cursor: body.cursor,
            offset: body.offset,
            context: input.context,
          }),
        };
      }
      case 'API-IMPORT-API-LIBRARY': {
        const body = parseBody(ImportApiLibrarySchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: 'api_library',
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        const fileIds = assertUniqueIds(body.fileIds, 'fileIds', input.context);
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: fileIds.length,
          sizeBytes: 0,
          context: input.context,
        });
        const contents = await this.dependencies.customApi.content({
          config: body.config as Record<string, unknown>,
          credentials: body.credentials as Record<string, unknown>,
          fileIds,
          context: input.context,
        });
        const materials: IngestionContentResult[] = [];
        try {
          for (const content of contents) {
            materials.push(
              await this.dependencies.content.materializeProviderContent({
                kind: 'api_library',
                knowledgeSpaceId: targetSpaceId,
                directoryId: body.directoryId ?? null,
                connectorId: null,
                content,
                context: input.context,
              }),
            );
          }
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: 'api_library',
              sources: materials.map((material) => material.source),
              idempotencyKey: idempotency,
              requestHash,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, materials, targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, materials, targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-CONNECTOR-CONNECT': {
        const body = parseBody(ConnectorConnectSchema, input);
        const targetSpaceId = spaceId(input);
        const pathProvider = connectorProvider(input.params.provider, input.context);
        assertProviderIdentity({
          pathProvider,
          configProvider: (body.config as { provider?: unknown }).provider,
          credentialsProvider: (body.credentials as { provider?: unknown }).provider,
          bodyProvider: body.provider,
          context: input.context,
        });
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const connector = await this.dependencies.connectors.connect(
          targetSpaceId,
          {
            provider: pathProvider,
            name: body.name,
            credentials: body.credentials as Record<string, unknown>,
            config: body.config as Record<string, unknown>,
            syncEnabled: body.syncEnabled,
            syncIntervalMinutes: body.syncIntervalMinutes,
          },
          input.context,
        );
        return { status: 201, data: connector };
      }
      case 'API-CONNECTOR-CATALOG': {
        const body = parseBody(ConnectorCatalogRequestSchema, input);
        const targetSpaceId = spaceId(input);
        const provider = cloudProvider(input.params.provider, input.context);
        const connector = await this.dependencies.connectors.findByProvider(
          targetSpaceId,
          provider,
          input.context,
        );
        await assertSpaceAccess(
          this.dependencies,
          connector.knowledgeSpaceId,
          'write',
          input.context,
        );
        const credentials = await this.dependencies.connectors.decryptCredentials(
          connector.id,
          input.context,
        );
        const catalog = await this.dependencies.providers[provider].catalog({
          provider,
          config: connector.config,
          credentials,
          rootId: body.rootId,
          context: input.context,
        });
        return {
          status: 200,
          data: { ...catalog, verificationStatus: 'EXTERNAL_UNVERIFIED' },
        };
      }
      case 'API-CONNECTOR-IMPORT': {
        const body = parseBody(ConnectorImportSchema, input);
        const targetSpaceId = spaceId(input);
        await assertWriteAccess(this.dependencies, targetSpaceId, input.context);
        const provider = cloudProvider(input.params.provider, input.context);
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await preflightImport({
          dependencies: this.dependencies,
          operation: input,
          knowledgeSpaceId: targetSpaceId,
          importKind: provider,
          idempotencyKey: idempotency,
          requestHash,
        });
        if (replay) return { status: 202, data: replay.job };
        await assertQuota(this.dependencies, {
          operation: 'import',
          knowledgeSpaceId: targetSpaceId,
          sourceCount: body.externalIds.length,
          sizeBytes: 0,
          context: input.context,
        });
        const connector = await this.dependencies.connectors.findByProvider(
          targetSpaceId,
          provider,
          input.context,
        );
        const credentials = await this.dependencies.connectors.decryptCredentials(
          connector.id,
          input.context,
        );
        const contents = await this.dependencies.providers[provider].content({
          provider,
          config: connector.config,
          credentials,
          externalIds: assertUniqueIds(body.externalIds, 'externalIds', input.context),
          context: input.context,
        });
        const materials: IngestionContentResult[] = [];
        try {
          for (const content of contents) {
            materials.push(
              await this.dependencies.content.materializeProviderContent({
                kind: provider,
                knowledgeSpaceId: targetSpaceId,
                directoryId: body.directoryId ?? null,
                connectorId: connector.id,
                content,
                context: input.context,
              }),
            );
          }
          const result = await this.dependencies.imports.submit(
            commandOf({
              operation: input,
              knowledgeSpaceId: targetSpaceId,
              directoryId: body.directoryId ?? null,
              importKind: provider,
              sources: materials.map((material) => material.source),
              idempotencyKey: idempotency,
              requestHash,
            }),
            input.context,
          );
          if (result.replayed) {
            await compensate(this.dependencies, materials, targetSpaceId, input.context);
          }
          return { status: 202, data: result.job };
        } catch (error) {
          await compensate(this.dependencies, materials, targetSpaceId, input.context);
          throw error;
        }
      }
      case 'API-CONNECTOR-SYNC': {
        const connectorId = input.params.connectorId;
        if (!connectorId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'connectorId' },
          });
        }
        const body = parseBody(ConnectorSyncSchema, input);
        const connector = await this.dependencies.connectors.get(connectorId, input.context);
        await assertSpaceAccess(
          this.dependencies,
          connector.knowledgeSpaceId,
          'write',
          input.context,
        );
        const idempotency = idempotencyKey(input);
        const requestHash = operationHash(input);
        const replay = await this.dependencies.connectors.preflightSync(
          connectorId,
          {
            requestHash,
            idempotencyKey: idempotency,
          },
          input.context,
        );
        if (replay) return { status: 202, data: replay };
        await assertQuota(this.dependencies, {
          operation: 'sync',
          knowledgeSpaceId: connector.knowledgeSpaceId,
          sourceCount: 1,
          sizeBytes: 0,
          context: input.context,
        });
        const result = await this.dependencies.connectors.markSyncing(
          connectorId,
          {
            full: body.full,
            expectedCursorVersion: body.expectedCursorVersion,
            requestHash,
            idempotencyKey: idempotency,
          },
          input.context,
        );
        return { status: 202, data: result.job };
      }
      case 'API-CONNECTOR-GET': {
        const connectorId = input.params.connectorId;
        if (!connectorId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'connectorId' },
          });
        }
        const connector = await this.dependencies.connectors.get(connectorId, input.context);
        await assertSpaceAccess(
          this.dependencies,
          connector.knowledgeSpaceId,
          'read',
          input.context,
        );
        return {
          status: 200,
          data: connector,
        };
      }
      case 'API-CONNECTOR-UPDATE': {
        const connectorId = input.params.connectorId;
        if (!connectorId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'connectorId' },
          });
        }
        const body = parseBody(ConnectorUpdateSchema, input);
        const current = await this.dependencies.connectors.get(connectorId, input.context);
        await assertSpaceAccess(
          this.dependencies,
          current.knowledgeSpaceId,
          'manage',
          input.context,
        );
        if (
          (body.credentials &&
            (body.credentials as { provider?: unknown }).provider !== current.provider) ||
          (body.config && (body.config as { provider?: unknown }).provider !== current.provider)
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: {
              provider: current.provider,
              reason: 'connector_update_provider_mismatch',
            },
          });
        }
        return {
          status: 200,
          data: await this.dependencies.connectors.update(
            {
              connectorId,
              version: body.version,
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.credentials !== undefined
                ? { credentials: body.credentials as Record<string, unknown> }
                : {}),
              ...(body.config !== undefined
                ? { config: body.config as Record<string, unknown> }
                : {}),
              ...(body.syncEnabled !== undefined ? { syncEnabled: body.syncEnabled } : {}),
              ...(body.syncIntervalMinutes !== undefined
                ? { syncIntervalMinutes: body.syncIntervalMinutes }
                : {}),
              ...(body.credentialKeyVersion !== undefined
                ? { credentialKeyVersion: body.credentialKeyVersion }
                : {}),
            },
            input.context,
          ),
        };
      }
      case 'API-CONNECTOR-DELETE': {
        const connectorId = input.params.connectorId;
        if (!connectorId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { field: 'connectorId' },
          });
        }
        const current = await this.dependencies.connectors.get(connectorId, input.context);
        await assertSpaceAccess(
          this.dependencies,
          current.knowledgeSpaceId,
          'manage',
          input.context,
        );
        return {
          status: 202,
          data: await this.dependencies.connectors.delete(
            connectorId,
            current.version,
            input.context,
          ),
        };
      }
      default:
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { operationId: input.operationId },
        });
    }
  }
}

export function isS04Operation(operationId: string): boolean {
  return new Set([
    'API-IMPORT-FILES',
    'API-IMPORT-TEXT',
    'API-IMPORT-URL',
    'API-IMPORT-TEMPLATE',
    'API-IMPORT-BACKUP',
    'API-IMPORT-API-CATALOG',
    'API-IMPORT-API-LIBRARY',
    'API-CONNECTOR-CONNECT',
    'API-CONNECTOR-CATALOG',
    'API-CONNECTOR-IMPORT',
    'API-CONNECTOR-SYNC',
    'API-CONNECTOR-UPDATE',
    'API-CONNECTOR-GET',
    'API-CONNECTOR-DELETE',
  ]).has(operationId);
}
