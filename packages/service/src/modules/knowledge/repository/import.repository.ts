import { randomBytes, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeDirectoryDoc,
  KnowledgeSourceDoc,
  KnowledgeSpaceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeJobDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type {
  KnowledgeConnectorCursorDoc,
  KnowledgeConnectorDoc,
} from '../../../shared/persistence/schemas/knowledge-connector.schemas';
import type { KnowledgeObjectRefDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  ImportSourceDraft,
  ImportSubmissionCommand,
  ImportSubmissionPort,
  ImportSubmissionResult,
  JobView,
} from '../application/ingestion.ports';
import type {
  ConnectorChangeSetApplyInput,
  ConnectorChangeSetApplyResult,
} from '../application/s06-connector-sync.application';
import type { S6ConnectorSyncResult } from '../application/s06-processing-ports';

type Plain<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export interface ImportRepositoryHooks {
  beforeOutbox?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
}

export interface BackupConflict {
  rowNumber: number;
  code: 'KNOWLEDGE_CONFLICT';
  existingSourceId: string;
  existingVersion: number;
  externalId: string;
}

function objectIdOfDraft(value: string, context: TenantContext, field: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field, reason: 'object_id_required' },
    });
  }
  return new Types.ObjectId(value);
}

function jobView(document: Plain<KnowledgeJobDoc>): JobView {
  return {
    jobId: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: document.knowledgeSpaceId
      ? String(document.knowledgeSpaceId)
      : '000000000000000000000000',
    kind: document.kind,
    status: document.status,
    priority: document.priority,
    attempts: document.attempts,
    maxAttempts: document.maxAttempts,
    progress: document.progress,
    steps: [],
    error: document.error,
    result: document.result,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export class KnowledgeImportRepository implements ImportSubmissionPort {
  private readonly spaces: Model<KnowledgeSpaceDoc>;
  private readonly directories: Model<KnowledgeDirectoryDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly objects: Model<KnowledgeObjectRefDoc>;
  private readonly connectors: Model<KnowledgeConnectorDoc>;
  private readonly cursors: Model<KnowledgeConnectorCursorDoc>;
  private readonly audit: KnowledgeAuditRepository;

  constructor(
    private readonly connection: Connection,
    private readonly hooks: ImportRepositoryHooks = {},
  ) {
    const models = registerKnowledgeModels(connection);
    this.spaces = models.KnowledgeSpace as Model<KnowledgeSpaceDoc>;
    this.directories = models.KnowledgeDirectory as Model<KnowledgeDirectoryDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
    this.jobs = models.KnowledgeJob as Model<KnowledgeJobDoc>;
    this.objects = models.KnowledgeObjectRef as Model<KnowledgeObjectRefDoc>;
    this.connectors = models.KnowledgeConnector as Model<KnowledgeConnectorDoc>;
    this.cursors = models.KnowledgeConnectorCursor as Model<KnowledgeConnectorCursorDoc>;
    this.audit = new KnowledgeAuditRepository(connection);
  }

  private async existingJob(
    command: ImportSubmissionCommand,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<Plain<KnowledgeJobDoc> | null> {
    return this.jobs
      .findOne({
        workspaceId: requireWorkspaceId(context),
        idempotencyKey: command.idempotencyKey,
        deletedAt: null,
      })
      .session(session ?? null)
      .lean<Plain<KnowledgeJobDoc>>()
      .exec();
  }

  private replay(
    document: Plain<KnowledgeJobDoc>,
    requestHash: string,
    context: TenantContext,
  ): ImportSubmissionResult {
    if (document.inputSnapshot.requestHash !== requestHash) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          reason: 'idempotency_body_mismatch',
          jobId: String(document._id),
        },
      });
    }
    const sourceIds = Array.isArray(document.inputSnapshot.sourceIds)
      ? document.inputSnapshot.sourceIds.map(String)
      : [];
    return {
      parentJobId: String(document._id),
      sourceIds,
      status: document.status === 'succeeded' ? 'succeeded' : 'queued',
      version: document.version,
      replayed: true,
      job: jobView(document),
      result: document.result,
    };
  }

  private async validateTarget(
    command: ImportSubmissionCommand,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<{
    space: Plain<KnowledgeSpaceDoc>;
    directory: Plain<KnowledgeDirectoryDoc> | null;
  }> {
    const workspaceId = requireWorkspaceId(context);
    const space = await this.spaces
      .findOne({
        workspaceId,
        _id: objectIdOf(command.knowledgeSpaceId, context, 'spaceId'),
        deletedAt: null,
      })
      .session(session ?? null)
      .lean<Plain<KnowledgeSpaceDoc>>()
      .exec();
    if (!space || space.kind !== 'space') throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    let directory: Plain<KnowledgeDirectoryDoc> | null = null;
    if (command.directoryId) {
      directory = await this.directories
        .findOne({
          workspaceId,
          knowledgeSpaceId: space._id,
          _id: objectIdOf(command.directoryId, context, 'directoryId'),
          deletedAt: null,
        })
        .session(session ?? null)
        .lean<Plain<KnowledgeDirectoryDoc>>()
        .exec();
      if (!directory) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    }
    return { space, directory };
  }

  private sourceDocument(
    draft: ImportSourceDraft,
    command: ImportSubmissionCommand,
    space: Plain<KnowledgeSpaceDoc>,
    context: TenantContext,
  ): Record<string, unknown> {
    const sourceId = objectIdOfDraft(draft.id, context, 'sourceId');
    return {
      _id: sourceId,
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: space._id,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      directoryId: draft.directoryId ? objectIdOf(draft.directoryId, context, 'directoryId') : null,
      kind: draft.kind,
      name: draft.name,
      externalId: draft.externalId,
      connectorId: draft.connectorId ? objectIdOf(draft.connectorId, context, 'connectorId') : null,
      blobRefId: draft.blobRefId ? objectIdOf(draft.blobRefId, context, 'blobRefId') : null,
      originalUrl:
        typeof draft.metadata.originalUrl === 'string' ? draft.metadata.originalUrl : null,
      mimeType: draft.mimeType,
      sizeBytes: draft.sizeBytes,
      contentHash: draft.contentHash,
      parseProvider: draft.parseProvider,
      processingStatus: 'queued',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: space.sourcePermissionEnabled ? 'inherited' : 'disabled',
      permissionRevision: space.permissionRevision,
      ownershipMemberId: context.memberId,
      metadata: {
        ...draft.metadata,
        importKind: command.importKind,
        configurationHash: command.configurationHash,
        parseConfigSnapshot: command.parseConfigSnapshot,
        chunkingConfigSnapshot: command.chunkingConfigSnapshot,
        qaConfigSnapshot: command.qaConfigSnapshot,
      },
      tagValues: [],
    };
  }

  private async createObjectRef(
    draft: ImportSourceDraft,
    spaceId: Types.ObjectId,
    session: ClientSession,
    context: TenantContext,
  ): Promise<void> {
    if (!draft.object) return;
    if (draft.replaceSourceId) {
      await this.objects.updateMany(
        {
          workspaceId: requireWorkspaceId(context),
          knowledgeSpaceId: spaceId,
          sourceId: objectIdOf(draft.replaceSourceId, context, 'sourceId'),
          state: 'active',
          deletedAt: null,
        },
        {
          $set: {
            state: 'deleting',
            sourceId: null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
    }
    await this.objects.create(
      [
        {
          _id: objectIdOfDraft(draft.object.id, context, 'objectId'),
          workspaceId: requireWorkspaceId(context),
          knowledgeSpaceId: spaceId,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          provider: draft.object.provider,
          bucket: draft.object.bucket,
          objectKey: draft.object.objectKey,
          purpose: 'source',
          sourceId: objectIdOfDraft(draft.id, context, 'sourceId'),
          mimeType: draft.object.mimeType,
          sizeBytes: draft.object.sizeBytes,
          etag: draft.object.etag,
          sha256: draft.object.sha256,
          state: 'active',
          expiresAt: null,
          upload: {
            mode: 'single',
            status: 'completed',
            providerUploadId: null,
            pendingObjectKey: null,
            finalObjectKey: draft.object.objectKey,
            finalizedAt: new Date(),
            pendingUrlExpiresAt: null,
            partSizeBytes: draft.object.sizeBytes,
            partCount: 1,
            parts: [],
            originalName: draft.name,
            completedAt: new Date(),
            abortedAt: null,
          },
        },
      ],
      { session },
    );
  }

  private async bindExistingObject(
    draft: ImportSourceDraft,
    spaceId: Types.ObjectId,
    session: ClientSession,
    context: TenantContext,
  ): Promise<void> {
    if (!draft.blobRefId || draft.object) return;
    const result = await this.objects.updateOne(
      {
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: spaceId,
        _id: objectIdOf(draft.blobRefId, context, 'blobRefId'),
        purpose: 'source',
        state: 'active',
        sourceId: null,
        deletedAt: null,
      },
      {
        $set: {
          sourceId: objectIdOf(draft.id, context, 'sourceId'),
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', {
        field: 'uploadIds',
        reason: 'active_unbound_object_required',
      });
    }
  }

  private async replaceSource(
    draft: ImportSourceDraft,
    command: ImportSubmissionCommand,
    space: Plain<KnowledgeSpaceDoc>,
    session: ClientSession,
    context: TenantContext,
  ): Promise<number> {
    if (!draft.replaceSourceId) return 1;
    const existing = await this.sources
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: space._id,
        _id: objectIdOf(draft.replaceSourceId, context, 'sourceId'),
        deletedAt: null,
      })
      .session(session);
    if (!existing) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const expectedVersion = draft.replaceSourceVersion ?? existing.version;
    if (existing.version !== expectedVersion) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    }
    const updated = await this.sources
      .findOneAndUpdate(
        {
          _id: existing._id,
          workspaceId: context.workspaceId,
          version: expectedVersion,
          deletedAt: null,
        },
        {
          $set: {
            directoryId: command.directoryId
              ? objectIdOf(command.directoryId, context, 'directoryId')
              : null,
            name: draft.name,
            blobRefId: draft.blobRefId ? objectIdOf(draft.blobRefId, context, 'blobRefId') : null,
            mimeType: draft.mimeType,
            sizeBytes: draft.sizeBytes,
            contentHash: draft.contentHash,
            processingStatus: 'queued',
            metadata: {
              ...draft.metadata,
              importKind: command.importKind,
              configurationHash: command.configurationHash,
            },
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1, sourceVersion: 1 },
        },
        { new: true, session },
      )
      .lean<Plain<KnowledgeSourceDoc> | null>();
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    return updated.sourceVersion;
  }

  async preflight(
    command: ImportSubmissionCommand,
    context: TenantContext,
  ): Promise<ImportSubmissionResult | null> {
    requireWorkspaceId(context);
    if (command.workspaceId !== context.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'workspace_mismatch' },
      });
    }
    const existing = await this.existingJob(command, context);
    return existing ? this.replay(existing, command.requestHash, context) : null;
  }

  async replayConnectorSync(
    input: {
      connectorId: string;
      knowledgeSpaceId: string;
      syncRunId: string;
    },
    context: TenantContext,
  ): Promise<S6ConnectorSyncResult | null> {
    const workspaceId = requireWorkspaceId(context);
    const syncRunId = objectIdOfDraft(input.syncRunId, context, 'syncRunId');
    const cursor = await this.cursors
      .findOne({
        workspaceId,
        connectorId: objectIdOf(input.connectorId, context, 'connectorId'),
        syncRunId,
      })
      .lean<KnowledgeConnectorCursorDoc & { _id: Types.ObjectId }>();
    if (!cursor) return null;
    const connector = await this.connectors
      .findOne({
        workspaceId,
        _id: cursor.connectorId,
        deletedAt: null,
      })
      .lean<KnowledgeConnectorDoc & { _id: Types.ObjectId }>();
    if (!connector) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const sources = await this.sources
      .find({
        workspaceId,
        knowledgeSpaceId: cursor.knowledgeSpaceId,
        connectorId: cursor.connectorId,
        deletedAt: null,
      })
      .select({ _id: 1, sourceVersion: 1 })
      .lean<Array<{ _id: Types.ObjectId; sourceVersion: number }>>();
    return {
      sourceIds: sources.map((source) => String(source._id)),
      sourceVersions: Object.fromEntries(
        sources.map((source) => [String(source._id), source.sourceVersion]),
      ),
      cursorVersion: connector.cursorVersion,
      sourceCount: sources.length,
      changeSetHash: cursor.lastChangeSetHash,
      replayed: true,
    };
  }

  async applyConnectorChangeSet(
    input: ConnectorChangeSetApplyInput,
    context: TenantContext,
  ): Promise<ConnectorChangeSetApplyResult> {
    const workspaceId = requireWorkspaceId(context);
    const connectorObjectId = objectIdOf(input.connectorId, context, 'connectorId');
    const spaceObjectId = objectIdOf(input.knowledgeSpaceId, context, 'knowledgeSpaceId');
    const syncRunId = objectIdOfDraft(input.syncRunId, context, 'syncRunId');
    const command: ImportSubmissionCommand = {
      workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      directoryId: null,
      importKind: input.provider,
      idempotencyKey: `connector-sync:${input.syncRunId}`,
      requestHash: input.changeSetHash,
      configurationHash: input.changeSetHash,
      sourceDrafts: [],
      parseConfigSnapshot: { provider: 'liteparse' },
      chunkingConfigSnapshot: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      qaConfigSnapshot: {},
    };
    return withMongoTransaction(this.connection, async (session) => {
      const { space } = await this.validateTarget(command, context, session);
      const connector = await this.connectors
        .findOne({
          workspaceId,
          _id: connectorObjectId,
          deletedAt: null,
        })
        .session(session)
        .lean<KnowledgeConnectorDoc & { _id: Types.ObjectId }>();
      if (!connector) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      const existingCursor = await this.cursors
        .findOne({
          workspaceId,
          connectorId: connectorObjectId,
          externalRootId: input.externalRootId,
        })
        .session(session)
        .lean<KnowledgeConnectorCursorDoc & { _id: Types.ObjectId }>();
      if (existingCursor?.syncRunId && String(existingCursor.syncRunId) === input.syncRunId) {
        const replay = await this.replayConnectorSync(
          {
            connectorId: input.connectorId,
            knowledgeSpaceId: input.knowledgeSpaceId,
            syncRunId: input.syncRunId,
          },
          context,
        );
        if (replay) return { ...replay, obsoleteObjectKeys: [] };
      }
      if (
        connector.status !== 'syncing' ||
        connector.cursorVersion !== input.expectedCursorVersion
      ) {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          connectorId: input.connectorId,
          reason: 'connector_cursor_cas',
          expected: input.expectedCursorVersion,
          actual: connector.cursorVersion,
        });
      }

      const sourceIds: string[] = [];
      const sourceVersions: Record<string, number> = {};
      const obsoleteObjectKeys: string[] = [];
      const drafts: ImportSourceDraft[] = [];
      for (const material of input.sources) {
        const draft: ImportSourceDraft = {
          ...material.source,
          connectorId: input.connectorId,
          directoryId: null,
        };
        if (!draft.externalId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'externalId', reason: 'required_for_connector_sync' },
          });
        }
        const existing = await this.sources
          .findOne({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            connectorId: connectorObjectId,
            externalId: draft.externalId,
            deletedAt: null,
          })
          .session(session)
          .lean<KnowledgeSourceDoc & { _id: Types.ObjectId }>();
        if (
          existing &&
          existing.contentHash === draft.contentHash &&
          existing.name === draft.name
        ) {
          if (material.createdObjectKey) obsoleteObjectKeys.push(material.createdObjectKey);
          sourceIds.push(String(existing._id));
          sourceVersions[String(existing._id)] = existing.sourceVersion;
          continue;
        }
        if (existing) {
          draft.id = String(existing._id);
          draft.replaceSourceId = String(existing._id);
          draft.replaceSourceVersion = existing.version;
        }
        drafts.push(draft);
        const sourceVersion = await this.replaceSource(draft, command, space, session, context);
        if (!existing) {
          await this.sources.create([this.sourceDocument(draft, command, space, context)], {
            session,
            ordered: true,
          });
        }
        await this.bindExistingObject(draft, space._id, session, context);
        await this.createObjectRef(draft, space._id, session, context);
        sourceIds.push(draft.id);
        sourceVersions[draft.id] = sourceVersion;
      }
      command.sourceDrafts = drafts;
      const cursorVersion = input.expectedCursorVersion + 1;
      const now = new Date();
      await this.cursors.findOneAndUpdate(
        {
          workspaceId,
          connectorId: connectorObjectId,
          externalRootId: input.externalRootId,
        },
        {
          $set: {
            cursor: input.cursor,
            cursorVersion,
            syncRunId,
            checkpointAt: now,
            lastChangeSetHash: input.changeSetHash,
            updatedByMemberId: context.memberId,
          },
          $setOnInsert: {
            workspaceId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            connectorId: connectorObjectId,
            externalRootId: input.externalRootId,
          },
        },
        { upsert: true, new: true, session, setDefaultsOnInsert: true },
      );
      const updatedConnector = await this.connectors.findOneAndUpdate(
        {
          _id: connectorObjectId,
          workspaceId,
          cursorVersion: input.expectedCursorVersion,
          status: 'syncing',
          deletedAt: null,
        },
        {
          $set: {
            cursorVersion,
            lastSuccessAt: now,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updatedConnector) {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          connectorId: input.connectorId,
          reason: 'connector_cursor_cas',
        });
      }
      return {
        sourceIds: [...new Set(sourceIds)],
        sourceVersions,
        cursorVersion,
        sourceCount: new Set(sourceIds).size,
        changeSetHash: input.changeSetHash,
        replayed: false,
        obsoleteObjectKeys,
      };
    });
  }

  async submit(
    command: ImportSubmissionCommand,
    context: TenantContext,
  ): Promise<ImportSubmissionResult> {
    requireWorkspaceId(context);
    if (command.workspaceId !== context.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'workspace_mismatch' },
      });
    }
    const existing = await this.existingJob(command, context);
    if (existing) return this.replay(existing, command.requestHash, context);

    try {
      return await withMongoTransaction(this.connection, async (session) => {
        const duplicate = await this.existingJob(command, context, session);
        if (duplicate) return this.replay(duplicate, command.requestHash, context);
        const { space } = await this.validateTarget(command, context, session);
        const sourceIds = command.sourceDrafts.map((draft) => draft.id);
        const sourceVersions: Record<string, number> = {};
        const jobId = new Types.ObjectId();
        const now = new Date();

        for (const draft of command.sourceDrafts) {
          sourceVersions[draft.id] = await this.replaceSource(
            draft,
            command,
            space,
            session,
            context,
          );
          if (!draft.replaceSourceId) {
            await this.sources.create([this.sourceDocument(draft, command, space, context)], {
              session,
              ordered: true,
            });
          }
          await this.bindExistingObject(draft, space._id, session, context);
          await this.createObjectRef(draft, space._id, session, context);
        }

        const documents = await this.jobs.create(
          [
            {
              _id: jobId,
              workspaceId: context.workspaceId,
              knowledgeSpaceId: space._id,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'import',
              resourceType: 'space',
              resourceId: String(space._id),
              status: 'queued',
              priority: 5,
              idempotencyKey: command.idempotencyKey,
              inputSnapshot: {
                sourceIds: sourceIds.map((id) => objectIdOfDraft(id, context, 'sourceId')),
                sourceVersions,
                configurationHash: command.configurationHash,
                requestHash: command.requestHash,
                importKind: command.importKind,
                directoryId: command.directoryId,
                parseConfigSnapshot: command.parseConfigSnapshot,
                chunkingConfigSnapshot: command.chunkingConfigSnapshot,
                qaConfigSnapshot: command.qaConfigSnapshot,
                dryRun: command.dryRun ?? false,
                conflictStrategy: command.conflictStrategy ?? 'fail',
              },
              progress: {
                stage: 'queued',
                completed: 0,
                total: sourceIds.length,
                percent: 0,
              },
              attempts: 0,
              maxAttempts: 3,
              attemptEpoch: 0,
              fencingToken: 'unassigned',
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              availableAt: now,
              cancelRequestedAt: null,
              pausedAt: null,
              error: null,
              result: null,
              expiresAt: new Date(now.getTime() + 30 * 86_400_000),
            },
          ],
          { session, ordered: true },
        );
        const job = documents[0];
        if (!job) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 'import_job_create_failed' },
          });
        }
        await this.audit.append(
          {
            knowledgeSpaceId: String(space._id),
            action: `import.${command.importKind}.submit`,
            resourceType: 'job',
            resourceId: String(jobId),
            outcome: 'succeeded',
            safeDiff: {
              importKind: command.importKind,
              sourceCount: sourceIds.length,
              configurationHash: command.configurationHash,
            },
          },
          context,
          session,
        );
        await this.hooks.beforeOutbox?.();
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(space._id),
            eventType: 'import.submit',
            aggregateType: 'job',
            aggregateId: String(jobId),
            queue: 'knowledge-import',
            payload: {
              parentJobId: String(jobId),
              sourceIds,
              importKind: command.importKind,
              configurationHash: command.configurationHash,
              requestHash: command.requestHash,
            },
          },
          context,
          session,
        );
        await this.hooks.beforeCommit?.();
        return {
          parentJobId: String(jobId),
          sourceIds,
          status: 'queued',
          version: 1,
          replayed: false,
          job: jobView(job.toObject() as unknown as Plain<KnowledgeJobDoc>),
        };
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await this.existingJob(command, context);
      if (!raced) throw error;
      return this.replay(raced, command.requestHash, context);
    }
  }

  async backupConflicts(
    spaceId: string,
    externalIds: readonly string[],
    context: TenantContext,
  ): Promise<BackupConflict[]> {
    if (externalIds.length === 0) return [];
    const sources = await this.sources
      .find({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        externalId: { $in: [...externalIds] },
        deletedAt: null,
      })
      .select({ _id: 1, externalId: 1, version: 1 })
      .lean()
      .exec();
    return sources.map((source, index) => ({
      rowNumber: index + 1,
      code: 'KNOWLEDGE_CONFLICT',
      existingSourceId: String(source._id),
      existingVersion: Number(source.version),
      externalId: String(source.externalId),
    }));
  }

  async createDryRunJob(
    input: {
      knowledgeSpaceId: string;
      idempotencyKey: string;
      requestHash: string;
      configurationHash: string;
      importKind: 'backup';
      dryRun?: boolean;
      conflicts: readonly BackupConflict[];
      actions: readonly Record<string, unknown>[];
    },
    context: TenantContext,
  ): Promise<ImportSubmissionResult> {
    const command = {
      workspaceId: context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      directoryId: null,
      importKind: input.importKind,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      configurationHash: input.configurationHash,
      sourceDrafts: [],
      parseConfigSnapshot: {},
      chunkingConfigSnapshot: {},
      qaConfigSnapshot: {},
      dryRun: input.dryRun ?? true,
    } satisfies ImportSubmissionCommand;
    const existing = await this.existingJob(command, context);
    if (existing) return this.replay(existing, input.requestHash, context);
    await this.validateTarget(command, context);
    const now = new Date();
    const dryRun = input.dryRun ?? true;
    const result = {
      dryRun,
      conflicts: input.conflicts,
      actions: input.actions,
    };
    const jobId = new Types.ObjectId();
    let plain: Plain<KnowledgeJobDoc>;
    try {
      const document = await this.jobs.create({
        _id: jobId,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: new Types.ObjectId(input.knowledgeSpaceId),
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        kind: 'import',
        resourceType: 'space',
        resourceId: input.knowledgeSpaceId,
        status: 'succeeded',
        priority: 5,
        idempotencyKey: input.idempotencyKey,
        inputSnapshot: {
          sourceIds: [],
          configurationHash: input.configurationHash,
          requestHash: input.requestHash,
          importKind: 'backup',
          dryRun,
        },
        progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
        attempts: 0,
        maxAttempts: 3,
        attemptEpoch: 0,
        fencingToken: 'unassigned',
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: now,
        cancelRequestedAt: null,
        pausedAt: null,
        error: null,
        result,
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      });
      plain = document.toObject() as unknown as Plain<KnowledgeJobDoc>;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await this.existingJob(command, context);
      if (!raced) throw error;
      return this.replay(raced, input.requestHash, context);
    }
    return {
      parentJobId: String(jobId),
      sourceIds: [],
      status: 'succeeded',
      version: 1,
      replayed: false,
      job: jobView(plain),
      result,
    };
  }
}

export function newImportId(): string {
  return randomBytes(12).toString('hex');
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
