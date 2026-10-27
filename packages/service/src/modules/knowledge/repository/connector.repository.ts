import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeConnectorDoc,
  KnowledgeConnectorCursorDoc,
} from '../../../shared/persistence/schemas/knowledge-connector.schemas';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeJobDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type {
  ConnectorConnectCommand,
  ConnectorRepositoryPort,
  ConnectorUpdateCommand,
  ConnectorView,
  JobView,
} from '../application/ingestion.ports';
import type { KnowledgeCredentialCipher } from '../adapter/credential-cipher';
import { assertConnectorTransition } from '../domain/connector-state';

type Plain<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function credentialMetadata(
  document: Plain<KnowledgeConnectorDoc>,
): ConnectorView['credentialMetadata'] {
  const fields =
    document.provider === 'feishu'
      ? ['appSecret']
      : document.provider === 'yuque'
        ? ['token']
        : document.provider === 'dingtalk'
          ? ['appSecret']
          : ['authorization'];
  return {
    provider: document.provider,
    schemaVersion: document.credentialSchemaVersion,
    keyVersion: document.credentialKeyVersion,
    configured: document.credentialCiphertext !== 'ERASED',
    redactedFields: fields,
  };
}

function connectorView(document: Plain<KnowledgeConnectorDoc>): ConnectorView {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    provider: document.provider,
    name: document.name,
    status: document.status,
    syncEnabled: document.syncEnabled,
    syncIntervalMinutes: document.syncIntervalMinutes,
    nextSyncAt: iso(document.nextSyncAt),
    lastAttemptAt: iso(document.lastAttemptAt),
    lastSuccessAt: iso(document.lastSuccessAt),
    lastError: document.lastError,
    cursorVersion: document.cursorVersion,
    version: document.version,
    config: document.config,
    credentialMetadata: credentialMetadata(document),
  };
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

function jobDocument(input: {
  kind: 'sync' | 'delete';
  spaceId: Types.ObjectId;
  resourceType: 'connector' | 'source';
  resourceId: string;
  idempotencyKey: string;
  inputSnapshot: Record<string, unknown>;
  context: TenantContext;
  total: number;
}) {
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    workspaceId: input.context.workspaceId,
    knowledgeSpaceId: input.spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: input.context.memberId,
    updatedByMemberId: input.context.memberId,
    kind: input.kind,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    status: 'queued',
    priority: 5,
    idempotencyKey: input.idempotencyKey,
    inputSnapshot: input.inputSnapshot,
    progress: { stage: 'queued', completed: 0, total: input.total, percent: 0 },
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
  };
}

export class KnowledgeConnectorRepository implements ConnectorRepositoryPort {
  private readonly connectors: Model<KnowledgeConnectorDoc>;
  private readonly cursors: Model<KnowledgeConnectorCursorDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly audit: KnowledgeAuditRepository;

  constructor(
    private readonly connection: Connection,
    private readonly cipher: KnowledgeCredentialCipher,
  ) {
    const models = registerKnowledgeModels(connection);
    this.connectors = models.KnowledgeConnector as Model<KnowledgeConnectorDoc>;
    this.cursors = models.KnowledgeConnectorCursor as Model<KnowledgeConnectorCursorDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
    this.jobs = models.KnowledgeJob as Model<KnowledgeJobDoc>;
    this.audit = new KnowledgeAuditRepository(connection);
  }

  private async targetSpace(
    spaceId: string,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<Types.ObjectId> {
    const id = objectIdOf(spaceId, context, 'spaceId');
    const space = await this.connection.models.KnowledgeSpace?.findOne({
      _id: id,
      workspaceId: context.workspaceId,
      kind: 'space',
      deletedAt: null,
    })
      .session(session ?? null)
      .lean();
    if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return id;
  }

  async connect(
    spaceId: string,
    command: ConnectorConnectCommand,
    context: TenantContext,
  ): Promise<ConnectorView> {
    requireWorkspaceId(context);
    const space = await this.targetSpace(spaceId, context);
    const encrypted = this.cipher.encrypt(command.credentials, {
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      provider: command.provider,
      schemaVersion: 1,
    });
    try {
      const now = new Date();
      const document = await this.connectors.create({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: space,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        provider: command.provider,
        name: command.name,
        credentialSchemaVersion: 1,
        credentialCiphertext: encrypted.ciphertext,
        credentialKeyVersion: encrypted.keyVersion,
        configSchemaVersion: 1,
        config: command.config,
        status: command.syncEnabled ? 'active' : 'paused',
        syncEnabled: command.syncEnabled,
        syncIntervalMinutes: command.syncIntervalMinutes,
        nextSyncAt: command.syncEnabled ? now : null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        cursorVersion: 1,
      });
      return connectorView(document.toObject() as unknown as Plain<KnowledgeConnectorDoc>);
    } catch (error) {
      if (duplicateKey(error)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'connector_provider_exists', provider: command.provider },
        });
      }
      throw error;
    }
  }

  async get(connectorId: string, context: TenantContext): Promise<ConnectorView> {
    const document = await this.connectors
      .findOne({
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(connectorId, context, 'connectorId'),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeConnectorDoc>>()
      .exec();
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return connectorView(document);
  }

  async findByProvider(
    spaceId: string,
    provider: ConnectorView['provider'],
    context: TenantContext,
  ): Promise<ConnectorView> {
    const document = await this.connectors
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        provider,
        deletedAt: null,
      })
      .lean<Plain<KnowledgeConnectorDoc>>()
      .exec();
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return connectorView(document);
  }

  async update(command: ConnectorUpdateCommand, context: TenantContext): Promise<ConnectorView> {
    const workspaceId = requireWorkspaceId(context);
    const current = await this.connectors
      .findOne({
        workspaceId,
        _id: objectIdOf(command.connectorId, context, 'connectorId'),
        version: command.version,
        deletedAt: null,
      })
      .lean<Plain<KnowledgeConnectorDoc>>()
      .exec();
    if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    if (
      (command.config && command.config.provider !== current.provider) ||
      (command.credentials && command.credentials.provider !== current.provider)
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          provider: current.provider,
          reason: command.credentials ? 'credentials_provider_mismatch' : 'provider_mismatch',
        },
      });
    }
    const update: Record<string, unknown> = {
      updatedByMemberId: context.memberId,
    };
    if (command.name !== undefined) update.name = command.name;
    if (command.config !== undefined) update.config = command.config;
    if (command.syncIntervalMinutes !== undefined) {
      update.syncIntervalMinutes = command.syncIntervalMinutes;
    }
    if (command.credentials !== undefined) {
      const encrypted = this.cipher.encrypt(command.credentials, {
        workspaceId,
        knowledgeSpaceId: String(current.knowledgeSpaceId),
        provider: current.provider,
        schemaVersion: 1,
      });
      update.credentialCiphertext = encrypted.ciphertext;
      update.credentialKeyVersion = current.credentialKeyVersion;
    }
    if (command.syncEnabled !== undefined) {
      const nextStatus = command.syncEnabled ? 'active' : 'paused';
      if (current.status !== nextStatus) {
        assertConnectorTransition(current.status, nextStatus, context);
      }
      update.syncEnabled = command.syncEnabled;
      update.status = nextStatus;
      update.nextSyncAt = command.syncEnabled ? new Date() : null;
    }
    const updated = await this.connectors
      .findOneAndUpdate(
        {
          _id: current._id,
          workspaceId,
          version: command.version,
          deletedAt: null,
        },
        { $set: update, $inc: { version: 1 } },
        { new: true },
      )
      .lean<Plain<KnowledgeConnectorDoc>>()
      .exec();
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    await this.audit.appendStandalone(
      {
        knowledgeSpaceId: String(current.knowledgeSpaceId),
        action: 'connector.update',
        resourceType: 'connector',
        resourceId: command.connectorId,
        outcome: 'succeeded',
        safeDiff: {
          provider: current.provider,
          fields: Object.keys(update).filter((field) => field !== 'updatedByMemberId'),
        },
      },
      context,
    );
    return connectorView(updated);
  }

  async decryptCredentials(
    connectorId: string,
    context: TenantContext,
  ): Promise<Record<string, unknown>> {
    const document = await this.connectors
      .findOne({
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(connectorId, context, 'connectorId'),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeConnectorDoc>>()
      .exec();
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return this.cipher.decrypt(document.credentialCiphertext, {
      workspaceId: document.workspaceId,
      knowledgeSpaceId: String(document.knowledgeSpaceId),
      provider: document.provider,
      schemaVersion: document.credentialSchemaVersion,
    });
  }

  async getSyncCursor(
    connectorId: string,
    externalRootId: string,
    context: TenantContext,
  ): Promise<{
    cursor: Record<string, unknown>;
    cursorVersion: number;
    syncRunId: string | null;
    lastChangeSetHash: string;
  } | null> {
    const cursor = await this.cursors
      .findOne({
        workspaceId: requireWorkspaceId(context),
        connectorId: objectIdOf(connectorId, context, 'connectorId'),
        externalRootId,
      })
      .lean<Plain<KnowledgeConnectorCursorDoc>>();
    if (!cursor) return null;
    return {
      cursor: cursor.cursor,
      cursorVersion: cursor.cursorVersion,
      syncRunId: cursor.syncRunId ? String(cursor.syncRunId) : null,
      lastChangeSetHash: cursor.lastChangeSetHash,
    };
  }

  async completeSync(
    input: {
      connectorId: string;
      success: boolean;
      errorCode?: string;
    },
    context: TenantContext,
  ): Promise<void> {
    const connector = await this.connectors
      .findOne({
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(input.connectorId, context, 'connectorId'),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeConnectorDoc>>();
    if (!connector) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    if (connector.status === 'active' || connector.status === 'failed') return;
    if (connector.status !== 'syncing') return;
    const now = new Date();
    await this.connectors.updateOne(
      {
        _id: connector._id,
        workspaceId: connector.workspaceId,
        version: connector.version,
        status: 'syncing',
        deletedAt: null,
      },
      {
        $set: {
          status: input.success ? 'active' : 'failed',
          nextSyncAt: input.success
            ? new Date(now.getTime() + connector.syncIntervalMinutes * 60_000)
            : null,
          lastSuccessAt: input.success ? now : connector.lastSuccessAt,
          lastError: input.success
            ? null
            : {
                code: input.errorCode ?? 'KNOWLEDGE_JOB_FAILED',
                retryable: false,
              },
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
    );
  }

  async preflightSync(
    connectorId: string,
    command: {
      requestHash: string;
      idempotencyKey: string;
    },
    context: TenantContext,
  ): Promise<JobView | null> {
    const existing = await this.jobs
      .findOne({
        workspaceId: requireWorkspaceId(context),
        idempotencyKey: `connector-sync:${connectorId}:${command.idempotencyKey}`,
        deletedAt: null,
      })
      .lean<Plain<KnowledgeJobDoc>>();
    if (!existing) return null;
    if (existing.inputSnapshot.requestHash !== command.requestHash) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          reason: 'idempotency_body_mismatch',
          jobId: String(existing._id),
        },
      });
    }
    return jobView(existing);
  }

  async markSyncing(
    connectorId: string,
    command: {
      full: boolean;
      expectedCursorVersion?: number;
      requestHash: string;
      idempotencyKey: string;
    },
    context: TenantContext,
  ): Promise<{ connector: ConnectorView; job: JobView }> {
    const idempotencyKey = `connector-sync:${connectorId}:${command.idempotencyKey}`;
    const replay = async (): Promise<{ connector: ConnectorView; job: JobView } | null> => {
      const existing = await this.jobs
        .findOne({
          workspaceId: context.workspaceId,
          idempotencyKey,
          deletedAt: null,
        })
        .lean<Plain<KnowledgeJobDoc>>();
      if (!existing) return null;
      if (existing.inputSnapshot.requestHash !== command.requestHash) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: {
            reason: 'idempotency_body_mismatch',
            jobId: String(existing._id),
          },
        });
      }
      const connector = await this.connectors
        .findOne({
          workspaceId: context.workspaceId,
          _id: objectIdOf(connectorId, context, 'connectorId'),
          deletedAt: null,
        })
        .lean<Plain<KnowledgeConnectorDoc>>();
      if (!connector) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      return { connector: connectorView(connector), job: jobView(existing) };
    };
    const replayed = await replay();
    if (replayed) return replayed;
    try {
      return await withMongoTransaction(this.connection, async (session) => {
        const current = await this.connectors
          .findOne({
            workspaceId: requireWorkspaceId(context),
            _id: objectIdOf(connectorId, context, 'connectorId'),
            deletedAt: null,
          })
          .session(session)
          .lean<Plain<KnowledgeConnectorDoc>>();
        if (!current) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        const spaceObjectId = current.knowledgeSpaceId;
        if (!spaceObjectId) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        if (current.provider === 'custom_api') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { provider: 'custom_api', operation: 'sync' },
          });
        }
        const existing = await this.jobs
          .findOne({
            workspaceId: context.workspaceId,
            idempotencyKey,
            deletedAt: null,
          })
          .session(session)
          .lean<Plain<KnowledgeJobDoc>>();
        if (existing) {
          if (existing.inputSnapshot.requestHash !== command.requestHash) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_CONFLICT',
              requestId: context.requestId,
              traceId: context.traceId,
              details: {
                reason: 'idempotency_body_mismatch',
                jobId: String(existing._id),
              },
            });
          }
          const connector = await this.connectors
            .findOne({
              workspaceId: context.workspaceId,
              _id: current._id,
              deletedAt: null,
            })
            .session(session)
            .lean<Plain<KnowledgeConnectorDoc>>();
          if (!connector) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
          return { connector: connectorView(connector), job: jobView(existing) };
        }
        if (!current.syncEnabled || current.status === 'paused' || current.status === 'failed') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 'connector_sync_disabled', status: current.status },
          });
        }
        if (
          command.expectedCursorVersion !== undefined &&
          command.expectedCursorVersion !== current.cursorVersion
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CURSOR_INVALID',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { expected: command.expectedCursorVersion, actual: current.cursorVersion },
          });
        }
        assertConnectorTransition(current.status, 'syncing', context);
        const updated = await this.connectors
          .findOneAndUpdate(
            {
              _id: current._id,
              workspaceId: context.workspaceId,
              version: current.version,
              status: current.status,
            },
            {
              $set: {
                status: 'syncing',
                lastAttemptAt: new Date(),
                nextSyncAt: null,
                lastError: null,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean<Plain<KnowledgeConnectorDoc>>();
        if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
        const [job] = await this.jobs.create(
          [
            jobDocument({
              kind: 'sync',
              spaceId: spaceObjectId,
              resourceType: 'connector',
              resourceId: connectorId,
              idempotencyKey,
              inputSnapshot: {
                connectorId,
                provider: current.provider,
                full: command.full,
                requestHash: command.requestHash,
                cursorVersion: current.cursorVersion,
              },
              context,
              total: 1,
            }),
          ],
          { session, ordered: true },
        );
        if (!job) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 'sync_job_create_failed' },
          });
        }
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(current.knowledgeSpaceId),
            eventType: 'connector.sync',
            aggregateType: 'job',
            aggregateId: String(job._id),
            queue: 'knowledge-sync',
            payload: {
              jobId: String(job._id),
              connectorId,
              provider: current.provider,
              full: command.full,
            },
          },
          context,
          session,
        );
        return {
          connector: connectorView(updated),
          job: jobView(job.toObject() as unknown as Plain<KnowledgeJobDoc>),
        };
      });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const raced = await replay();
      if (!raced) throw error;
      return raced;
    }
  }

  async delete(
    connectorId: string,
    version: number,
    context: TenantContext,
  ): Promise<{ id: string; status: 'accepted'; jobId: string | null }> {
    return withMongoTransaction(this.connection, async (session) => {
      const current = await this.connectors
        .findOne({
          workspaceId: requireWorkspaceId(context),
          _id: objectIdOf(connectorId, context, 'connectorId'),
          version,
          deletedAt: null,
        })
        .session(session)
        .lean<Plain<KnowledgeConnectorDoc>>();
      if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
      const spaceObjectId = current.knowledgeSpaceId;
      if (!spaceObjectId) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      assertConnectorTransition(current.status, 'deleting', context);
      const now = new Date();
      const updated = await this.connectors.findOneAndUpdate(
        {
          _id: current._id,
          workspaceId: context.workspaceId,
          version,
          deletedAt: null,
        },
        {
          $set: {
            status: 'deleted',
            deletedAt: now,
            syncEnabled: false,
            nextSyncAt: null,
            credentialCiphertext: 'ERASED',
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
      const sources = await this.sources
        .find({
          workspaceId: context.workspaceId,
          knowledgeSpaceId: spaceObjectId,
          connectorId: current._id,
          deletedAt: null,
        })
        .select({ _id: 1 })
        .session(session)
        .lean();
      if (sources.length > 0) {
        await this.sources.updateMany(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: current.knowledgeSpaceId,
            connectorId: current._id,
            deletedAt: null,
          },
          {
            $set: {
              processingStatus: 'deleting',
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
      }
      let firstJobId: string | null = null;
      for (const source of sources) {
        const [job] = await this.jobs.create(
          [
            jobDocument({
              kind: 'delete',
              spaceId: spaceObjectId,
              resourceType: 'source',
              resourceId: String(source._id),
              idempotencyKey: `connector-delete:${connectorId}:${String(source._id)}`,
              inputSnapshot: {
                connectorId,
                sourceId: String(source._id),
                reason: 'connector_deleted',
              },
              context,
              total: 1,
            }),
          ],
          { session, ordered: true },
        );
        if (!job) continue;
        firstJobId ??= String(job._id);
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(current.knowledgeSpaceId),
            eventType: 'source.delete',
            aggregateType: 'job',
            aggregateId: String(job._id),
            queue: 'knowledge-delete',
            payload: {
              jobId: String(job._id),
              connectorId,
              sourceId: String(source._id),
            },
          },
          context,
          session,
        );
      }
      await createKnowledgeOutboxEvent(
        this.connection,
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: String(current.knowledgeSpaceId),
          eventType: 'connector.delete',
          aggregateType: 'connector',
          aggregateId: connectorId,
          queue: 'knowledge-delete',
          payload: {
            connectorId,
            sourceCount: sources.length,
          },
        },
        context,
        session,
      );
      await this.audit.append(
        {
          knowledgeSpaceId: String(current.knowledgeSpaceId),
          action: 'connector.delete',
          resourceType: 'connector',
          resourceId: connectorId,
          outcome: 'succeeded',
          safeDiff: {
            provider: current.provider,
            propagatedSources: sources.length,
            credentialErased: true,
          },
        },
        context,
        session,
      );
      return { id: connectorId, status: 'accepted' as const, jobId: firstJobId };
    });
  }
}
