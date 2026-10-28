import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeSynonymConfigDoc,
  KnowledgeSynonymMappingDoc,
  KnowledgeModelBindingDoc,
} from '../../../shared/persistence/schemas/knowledge-governance.schemas';
import type {
  KnowledgeAuditEventDoc,
  KnowledgeObjectRefDoc,
} from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type {
  KnowledgeIdempotencyRecordDoc,
  KnowledgeJobDoc,
  KnowledgeOutboxEventDoc,
} from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type {
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import {
  buildRebuildPlan,
  rebuildIdempotencyKey,
  type SynonymRebuildPlan,
  type SynonymRebuildReason,
  type SynonymRebuildResult,
  type SynonymStagedRebuild,
} from '../domain/s09-synonym-rebuild';
import type { SynonymMapping } from '../domain/s09-synonym';
import type {
  S09CreatePendingVersionInput,
  S09PublishedSynonymSnapshot,
  S09SynonymConfigView,
  S09SynonymJobView,
  S09SynonymLastError,
  S09SynonymMappingPage,
  S09SynonymMappingView,
  S09SynonymRepositoryPort,
} from '../application/s09-synonym.ports';

type Plain<T> = T & {
  _id: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

interface MappingCursor {
  version: 1;
  fileVersion: number;
  after: string;
}

const CONFIG_SCOPE = 's09:synonym:file';

function validation(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function conflict(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function safeLastError(value: unknown): S09SynonymLastError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
  return {
    code: record.code,
    message: record.message.slice(0, 500),
    ...(Number.isInteger(record.rowNumber) ? { rowNumber: Number(record.rowNumber) } : {}),
  };
}

function mappingView(document: KnowledgeSynonymMappingDoc): S09SynonymMappingView {
  return {
    logicalMappingId: String(document.logicalMappingId),
    fileVersion: document.fileVersion,
    standardizedTerm: document.standardizedTerm,
    normalizedStandardizedTerm: document.normalizedStandardizedTerm,
    synonymTerms: [...document.synonymTerms],
    normalizedSynonymTerms: [...document.normalizedSynonymTerms],
    fingerprint: document.fingerprint,
  };
}

function mappingDomainView(document: KnowledgeSynonymMappingDoc): SynonymMapping {
  return {
    logicalMappingId: String(document.logicalMappingId),
    standardizedTerm: document.standardizedTerm,
    normalizedStandardizedTerm: document.normalizedStandardizedTerm,
    synonymTerms: [...document.synonymTerms],
    normalizedSynonymTerms: [...document.normalizedSynonymTerms],
    allTerms: document.allTerms,
    fingerprint: document.fingerprint,
    sourceRows: [...document.sourceRows],
  };
}

function jobView(document: KnowledgeJobDoc & { _id: Types.ObjectId }): S09SynonymJobView {
  return {
    jobId: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    kind: 'synonym_rebuild',
    resourceType: document.resourceType as 'synonym' | 'space',
    resourceId: document.resourceId,
    inputSnapshot: document.inputSnapshot,
    status: document.status,
    priority: document.priority,
    attempts: document.attempts,
    maxAttempts: document.maxAttempts,
    progress: document.progress,
    version: document.version,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function requestHash(input: S09CreatePendingVersionInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        expectedFileVersion: input.expectedFileVersion ?? null,
        enabled: input.enabled,
        reason: input.reason,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        sourceIds: [...input.sourceIds].sort(),
      }),
    )
    .digest('hex');
}

function synonymBlobId(input: {
  workspaceId: string;
  knowledgeSpaceId: string;
  checksumSha256: string;
  fileVersion: number;
}): Types.ObjectId {
  return new Types.ObjectId(
    createHash('sha256')
      .update(
        [
          input.workspaceId,
          input.knowledgeSpaceId,
          input.checksumSha256,
          String(input.fileVersion),
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 24),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeCursor(input: MappingCursor): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}

function decodeCursor(value: string, fileVersion: number, context: TenantContext): MappingCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw validation(context, { field: 'cursor', reason: 'invalid' });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1 ||
    Number((parsed as Record<string, unknown>).fileVersion) !== fileVersion ||
    typeof (parsed as Record<string, unknown>).after !== 'string'
  ) {
    throw validation(context, { field: 'cursor', reason: 'invalid' });
  }
  return parsed as MappingCursor;
}

function auditDocument(input: {
  workspaceId: string;
  knowledgeSpaceId: Types.ObjectId;
  context: TenantContext;
  action: string;
  resourceId: string;
  outcome: 'succeeded' | 'failed';
  safeDiff: Record<string, unknown>;
}) {
  const now = new Date();
  return {
    workspaceId: input.workspaceId,
    knowledgeSpaceId: input.knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: input.context.memberId,
    updatedByMemberId: input.context.memberId,
    eventId: randomUUID(),
    action: input.action,
    actorMemberId: input.context.memberId,
    apiKeyId: null,
    resourceType: 'space' as const,
    resourceId: input.resourceId,
    outcome: input.outcome,
    traceId: input.context.traceId,
    requestId: input.context.requestId,
    ipHash: createHash('sha256').update(input.context.requestId).digest('hex'),
    userAgentHash: createHash('sha256').update(input.context.traceId).digest('hex'),
    safeDiff: input.safeDiff,
    occurredAt: now,
    expiresAt: new Date(now.getTime() + 730 * 86_400_000),
  };
}

export class KnowledgeSynonymRepository implements S09SynonymRepositoryPort {
  private readonly configs: Model<KnowledgeSynonymConfigDoc>;
  private readonly mappings: Model<KnowledgeSynonymMappingDoc>;
  private readonly objects: Model<KnowledgeObjectRefDoc>;
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly outbox: Model<KnowledgeOutboxEventDoc>;
  private readonly audits: Model<KnowledgeAuditEventDoc>;
  private readonly idempotency: Model<KnowledgeIdempotencyRecordDoc>;
  private readonly bindings: Model<KnowledgeModelBindingDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly segments: Model<KnowledgeSegmentDoc>;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.configs = models.KnowledgeSynonymConfig;
    this.mappings = models.KnowledgeSynonymMapping;
    this.objects = models.KnowledgeObjectRef;
    this.jobs = models.KnowledgeJob;
    this.outbox = models.KnowledgeOutboxEvent;
    this.audits = models.KnowledgeAuditEvent;
    this.idempotency = models.KnowledgeIdempotencyRecord;
    this.bindings = models.KnowledgeModelBinding;
    this.sources = models.KnowledgeSource;
    this.segments = models.KnowledgeSegment;
  }

  private async mappingMetrics(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<{ mappingCount: number; termCount: number }> {
    const [result] = await this.mappings
      .aggregate<{ mappingCount: number; termCount: number }>([
        {
          $match: {
            workspaceId: requireWorkspaceId(context),
            knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
            fileVersion,
            deletedAt: null,
          },
        },
        {
          $group: {
            _id: null,
            mappingCount: { $sum: 1 },
            termCount: {
              $sum: { $add: [1, { $size: '$normalizedSynonymTerms' }] },
            },
          },
        },
        { $project: { _id: 0, mappingCount: 1, termCount: 1 } },
      ])
      .session(session ?? null)
      .exec();
    return {
      mappingCount: Number(result?.mappingCount ?? 0),
      termCount: Number(result?.termCount ?? 0),
    };
  }

  private async configView(
    document: Plain<KnowledgeSynonymConfigDoc>,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<S09SynonymConfigView> {
    const metrics = await this.mappingMetrics(
      String(document.knowledgeSpaceId),
      document.activeFileVersion,
      context,
      session,
    );
    return {
      knowledgeSpaceId: String(document.knowledgeSpaceId),
      fileName: document.fileName,
      sizeBytes: document.sizeBytes,
      activeFileVersion: document.activeFileVersion,
      enabled: document.enabled,
      schemaVersion: 2,
      status: document.status,
      mappingCount: metrics.mappingCount,
      termCount: metrics.termCount,
      version: document.version,
      updatedAt: document.updatedAt.toISOString(),
      lastError: safeLastError(document.lastError),
    };
  }

  private async findConfigDocument(
    spaceId: string,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<Plain<KnowledgeSynonymConfigDoc> | null> {
    return this.configs
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        deletedAt: null,
      })
      .session(session ?? null)
      .lean<Plain<KnowledgeSynonymConfigDoc>>()
      .exec();
  }

  private async jobForFileVersion(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<S09SynonymJobView | null> {
    const job = await this.jobs
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        kind: 'synonym_rebuild',
        'inputSnapshot.fileVersion': fileVersion,
        deletedAt: null,
      })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean<KnowledgeJobDoc & { _id: Types.ObjectId }>()
      .exec();
    return job ? jobView(job) : null;
  }

  private async existingIdempotentVersion(
    spaceId: string,
    input: S09CreatePendingVersionInput,
    context: TenantContext,
    session: ClientSession,
  ): Promise<{ fileVersion: number; record: Plain<KnowledgeIdempotencyRecordDoc> | null } | null> {
    const scope = `${CONFIG_SCOPE}:${spaceId}`;
    const record = await this.idempotency
      .findOne({
        workspaceId: requireWorkspaceId(context),
        scope,
        idempotencyKey: input.idempotencyKey,
        deletedAt: null,
      })
      .session(session)
      .lean<Plain<KnowledgeIdempotencyRecordDoc>>()
      .exec();
    if (record) {
      if (record.requestHash !== input.requestHash) {
        throw conflict(context, { reason: 'idempotency_body_mismatch' });
      }
      const fileVersion = Number(record.responseBody?.fileVersion);
      if (!Number.isInteger(fileVersion) || fileVersion < 1) {
        throw conflict(context, { reason: 'idempotency_response_invalid' });
      }
      return { fileVersion, record };
    }
    const existingObject = await this.objects
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        purpose: 'synonym',
        sha256: input.checksumSha256,
        deletedAt: null,
      })
      .sort({ synonymFileVersion: -1 })
      .session(session)
      .lean<KnowledgeObjectRefDoc>()
      .exec();
    const fileVersion = Number(existingObject?.synonymFileVersion);
    return Number.isInteger(fileVersion) && fileVersion > 0 ? { fileVersion, record: null } : null;
  }

  private idempotencyDocument(input: {
    spaceId: string;
    idempotencyKey: string;
    requestHash: string;
    fileVersion: number;
    context: TenantContext;
  }) {
    const now = new Date();
    return {
      workspaceId: requireWorkspaceId(input.context),
      knowledgeSpaceId: objectIdOf(input.spaceId, input.context, 'spaceId'),
      version: 1,
      deletedAt: null,
      createdByMemberId: input.context.memberId,
      updatedByMemberId: input.context.memberId,
      scope: `${CONFIG_SCOPE}:${input.spaceId}`,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: 'completed' as const,
      statusCode: 201,
      responseBody: { fileVersion: input.fileVersion },
      requestId: input.context.requestId,
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  async findByChecksum(
    spaceId: string,
    checksumSha256: string,
    context: TenantContext,
  ): Promise<number | null> {
    const object = await this.objects
      .findOne({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        purpose: 'synonym',
        sha256: checksumSha256,
        deletedAt: null,
      })
      .sort({ synonymFileVersion: -1 })
      .lean<KnowledgeObjectRefDoc>()
      .exec();
    return object?.synonymFileVersion ?? null;
  }

  async createPendingVersion(
    spaceId: string,
    input: S09CreatePendingVersionInput,
    context: TenantContext,
  ): Promise<{
    config: S09SynonymConfigView;
    job: S09SynonymJobView | null;
    replayed: boolean;
  }> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    const hash = input.requestHash || requestHash(input);
    if (
      input.rawFile.sha256 !== input.checksumSha256 ||
      input.rawFile.sizeBytes !== input.sizeBytes
    ) {
      throw validation(context, {
        field: 'rawFile',
        reason: 'checksum_or_size_mismatch',
      });
    }
    return withMongoTransaction(this.connection, async (session) => {
      const existing = await this.existingIdempotentVersion(
        spaceId,
        { ...input, requestHash: hash },
        context,
        session,
      );
      if (existing) {
        const document = await this.configs
          .findOne({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            deletedAt: null,
          })
          .session(session)
          .lean<Plain<KnowledgeSynonymConfigDoc>>()
          .exec();
        if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
        if (
          !existing.record &&
          input.expectedFileVersion !== undefined &&
          input.expectedFileVersion !== document.activeFileVersion
        ) {
          throw conflict(context, {
            field: 'expectedFileVersion',
            expected: input.expectedFileVersion,
            actual: document.activeFileVersion,
          });
        }
        if (!existing.record) {
          await this.idempotency.create(
            [
              this.idempotencyDocument({
                spaceId,
                idempotencyKey: input.idempotencyKey,
                requestHash: hash,
                fileVersion: existing.fileVersion,
                context,
              }),
            ],
            { session },
          );
        }
        return {
          config: await this.configView(document, context, session),
          job: await this.jobForFileVersion(spaceId, existing.fileVersion, context, session),
          replayed: true,
        };
      }

      let document = await this.findConfigDocument(spaceId, context, session);
      let fileVersion: number;
      let expectedActiveFileVersion: number;
      if (!document) {
        if (input.expectedFileVersion !== undefined) {
          throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
        }
        fileVersion = 1;
        expectedActiveFileVersion = 1;
        const created = new this.configs({
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          activeFileVersion: fileVersion,
          publishedFileVersion: null,
          lastFileVersion: fileVersion,
          pendingFileVersion: fileVersion,
          pendingJobId: null,
          pendingReason: input.reason,
          pendingStartedAt: new Date(),
          pendingSourceIds: [...input.sourceIds],
          enabled: input.enabled,
          schemaVersion: 2,
          status: 'rebuilding',
          uploadTime: new Date(),
          uploadedByMemberId: context.memberId,
          lastError: null,
          activeQueryModelId: null,
          activeQueryDimension: null,
        });
        await created.save({ session });
        document = created.toObject() as unknown as Plain<KnowledgeSynonymConfigDoc>;
      } else {
        if (
          input.expectedFileVersion !== undefined &&
          input.expectedFileVersion !== document.activeFileVersion
        ) {
          throw conflict(context, {
            field: 'expectedFileVersion',
            expected: input.expectedFileVersion,
            actual: document.activeFileVersion,
          });
        }
        if (document.status === 'rebuilding' || document.pendingJobId) {
          throw conflict(context, { reason: 'synonym_rebuild_in_progress', spaceId });
        }
        fileVersion = document.lastFileVersion + 1;
        expectedActiveFileVersion = document.activeFileVersion;
        const updated = await this.configs
          .findOneAndUpdate(
            {
              _id: document._id,
              workspaceId,
              version: document.version,
              deletedAt: null,
              status: { $ne: 'rebuilding' },
              pendingJobId: null,
            },
            {
              $set: {
                fileName: input.fileName,
                sizeBytes: input.sizeBytes,
                checksumSha256: input.checksumSha256,
                activeFileVersion: fileVersion,
                lastFileVersion: fileVersion,
                pendingFileVersion: fileVersion,
                pendingJobId: null,
                pendingReason: input.reason,
                pendingStartedAt: new Date(),
                pendingSourceIds: [...input.sourceIds],
                enabled: input.enabled,
                status: 'rebuilding',
                uploadTime: new Date(),
                uploadedByMemberId: context.memberId,
                lastError: null,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1 },
            },
            { new: true, runValidators: true, session },
          )
          .lean<Plain<KnowledgeSynonymConfigDoc>>()
          .exec();
        if (!updated) throw conflict(context, { reason: 'config_cas', spaceId });
        document = updated;
      }

      await this.mappings.insertMany(
        input.mappings.map((mapping) => ({
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          synonymConfigId: document!._id,
          fileVersion,
          logicalMappingId: new Types.ObjectId(mapping.logicalMappingId),
          standardizedTerm: mapping.standardizedTerm,
          normalizedStandardizedTerm: mapping.normalizedStandardizedTerm,
          synonymTerms: [...mapping.synonymTerms],
          normalizedSynonymTerms: [...mapping.normalizedSynonymTerms],
          allTerms: mapping.allTerms,
          fingerprint: mapping.fingerprint,
          sourceRows: [...mapping.sourceRows],
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
        })),
        { session, ordered: true },
      );

      const now = new Date();
      const blobId = synonymBlobId({
        workspaceId,
        knowledgeSpaceId: spaceId,
        checksumSha256: input.checksumSha256,
        fileVersion,
      });
      await this.objects.create(
        [
          {
            _id: blobId,
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            provider: input.rawFile.provider,
            bucket: input.rawFile.bucket,
            objectKey: input.rawFile.objectKey,
            purpose: 'synonym',
            synonymConfigId: document._id,
            synonymFileVersion: fileVersion,
            sourceId: null,
            mimeType: input.rawFile.mimeType,
            sizeBytes: input.rawFile.sizeBytes,
            etag: input.rawFile.etag,
            sha256: input.rawFile.sha256,
            state: 'active',
            expiresAt: null,
            upload: {
              mode: 'single',
              status: 'completed',
              providerUploadId: null,
              pendingObjectKey: null,
              finalObjectKey: input.rawFile.objectKey,
              finalizedAt: now,
              pendingUrlExpiresAt: null,
              partSizeBytes: Math.max(1, input.rawFile.sizeBytes),
              partCount: 1,
              parts: [],
              originalName: input.fileName.slice(0, 180),
              completedAt: now,
              abortedAt: null,
            },
          },
        ],
        { session },
      );

      const idempotencyKey = rebuildIdempotencyKey({
        knowledgeSpaceId: spaceId,
        fileVersion,
        reason: input.reason,
      });
      const [job] = await this.jobs.create(
        [
          {
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            kind: 'synonym_rebuild',
            resourceType: 'synonym',
            resourceId: String(document._id),
            status: 'queued',
            priority: 5,
            idempotencyKey,
            inputSnapshot: {
              fileVersion,
              expectedActiveFileVersion,
              sourceIds: [...input.sourceIds],
              indexedSegmentVersions: {},
              reason: input.reason,
            },
            progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
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
            expiresAt: new Date(now.getTime() + 180 * 86_400_000),
          },
        ],
        { session, ordered: true },
      );
      if (!job) throw tenantError(context);
      const jobDocument = job.toObject() as unknown as KnowledgeJobDoc & {
        _id: Types.ObjectId;
      };
      const configUpdated = await this.configs
        .findOneAndUpdate(
          {
            _id: document._id,
            workspaceId,
            version: document.version,
            pendingFileVersion: fileVersion,
          },
          {
            $set: { pendingJobId: String(job._id), updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<Plain<KnowledgeSynonymConfigDoc>>()
        .exec();
      if (!configUpdated) throw conflict(context, { reason: 'config_pending_job_cas' });

      await createKnowledgeOutboxEvent(
        this.connection,
        {
          workspaceId,
          knowledgeSpaceId: spaceId,
          eventType: 'synonym_rebuild.job.queued',
          aggregateType: 'job',
          aggregateId: String(job._id),
          queue: 'knowledge-rebuild',
          payload: { jobId: String(job._id) },
        },
        context,
        session,
      );
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.file.upload',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: {
              fileVersion,
              checksumSha256: input.checksumSha256,
              mappingCount: input.mappings.length,
              reason: input.reason,
            },
          }),
        ],
        { session },
      );
      await this.idempotency.create(
        [
          this.idempotencyDocument({
            spaceId,
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            fileVersion,
            context,
          }),
        ],
        { session },
      );
      return {
        config: await this.configView(configUpdated, context, session),
        job: jobView(jobDocument),
        replayed: false,
      };
    });
  }

  async getConfig(spaceId: string, context: TenantContext): Promise<S09SynonymConfigView> {
    const document = await this.findConfigDocument(spaceId, context);
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
    return this.configView(document, context);
  }

  async getMappingSnapshot(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
  ): Promise<SynonymMapping[] | null> {
    const documents = await this.mappings
      .find({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        fileVersion,
        deletedAt: null,
      })
      .sort({ normalizedStandardizedTerm: 1, logicalMappingId: 1 })
      .lean<KnowledgeSynonymMappingDoc[]>()
      .exec();
    return documents.length > 0 ? documents.map(mappingDomainView) : null;
  }

  async getPublishedSnapshot(
    spaceId: string,
    context: TenantContext,
  ): Promise<S09PublishedSynonymSnapshot | null> {
    const config = await this.findConfigDocument(spaceId, context);
    if (
      !config ||
      !config.enabled ||
      config.status === 'disabled' ||
      config.publishedFileVersion === null
    ) {
      return null;
    }
    const mappings = await this.getMappingSnapshot(spaceId, config.publishedFileVersion, context);
    return mappings
      ? {
          knowledgeSpaceId: spaceId,
          fileVersion: config.publishedFileVersion,
          mappings,
        }
      : null;
  }

  async assertPublishedVersion(
    spaceId: string,
    fileVersion: number,
    context: TenantContext,
  ): Promise<boolean> {
    const exists = await this.configs.exists({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      publishedFileVersion: fileVersion,
      enabled: true,
      status: { $ne: 'disabled' },
      deletedAt: null,
    });
    return exists !== null;
  }

  async listMappings(
    spaceId: string,
    input: {
      fileVersion?: number;
      cursor?: string;
      limit: number;
      search?: string;
    },
    context: TenantContext,
  ): Promise<S09SynonymMappingPage> {
    const config = await this.findConfigDocument(spaceId, context);
    if (!config) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
    const fileVersion =
      input.fileVersion ?? config.publishedFileVersion ?? config.activeFileVersion;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw validation(context, { field: 'limit', min: 1, max: 200 });
    }
    const cursor = input.cursor ? decodeCursor(input.cursor, fileVersion, context) : null;
    const filter: Record<string, unknown> = {
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      fileVersion,
      deletedAt: null,
    };
    if (input.search?.trim()) {
      filter.allTerms = {
        $regex: escapeRegex(input.search.trim()),
        $options: 'i',
      };
    }
    if (cursor) {
      filter.normalizedStandardizedTerm = { $gt: cursor.after };
    }
    const documents = await this.mappings
      .find(filter)
      .sort({ normalizedStandardizedTerm: 1, logicalMappingId: 1 })
      .limit(input.limit + 1)
      .lean<KnowledgeSynonymMappingDoc[]>()
      .exec();
    const hasMore = documents.length > input.limit;
    const items = documents.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items: items.map(mappingView),
      nextCursor:
        hasMore && last
          ? encodeCursor({ version: 1, fileVersion, after: last.normalizedStandardizedTerm })
          : null,
      hasMore,
      fileVersion,
    };
  }

  async toggle(
    spaceId: string,
    input: { enabled: boolean; version: number },
    context: TenantContext,
  ): Promise<S09SynonymConfigView> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    return withMongoTransaction(this.connection, async (session) => {
      const current = await this.findConfigDocument(spaceId, context, session);
      if (!current) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
      if (input.version !== current.version) {
        throw conflict(context, { reason: 'version_conflict', expected: input.version });
      }
      if (current.status === 'rebuilding' || current.pendingJobId) {
        throw conflict(context, { reason: 'synonym_rebuild_in_progress' });
      }
      if (input.enabled && current.publishedFileVersion === null) {
        throw conflict(context, { reason: 'published_version_required' });
      }
      const status = input.enabled
        ? current.publishedFileVersion !== null
          ? 'active'
          : 'failed'
        : 'disabled';
      const updated = await this.configs
        .findOneAndUpdate(
          {
            _id: current._id,
            workspaceId,
            version: input.version,
            deletedAt: null,
            status: { $ne: 'rebuilding' },
          },
          {
            $set: {
              enabled: input.enabled,
              status,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .lean<Plain<KnowledgeSynonymConfigDoc>>()
        .exec();
      if (!updated) throw conflict(context, { reason: 'config_cas', spaceId });
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.config.toggle',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: { enabled: input.enabled, fileVersion: updated.publishedFileVersion },
          }),
        ],
        { session },
      );
      return this.configView(updated, context, session);
    });
  }

  async disableAndDelete(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<{ id: string; status: 'disabled'; jobId: null }> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    return withMongoTransaction(this.connection, async (session) => {
      const current = await this.findConfigDocument(spaceId, context, session);
      if (!current) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
      if (input.version !== current.version) {
        throw conflict(context, { reason: 'version_conflict', expected: input.version });
      }
      if (current.status === 'rebuilding' || current.pendingJobId) {
        throw conflict(context, { reason: 'synonym_rebuild_in_progress' });
      }
      const updated = await this.configs
        .findOneAndUpdate(
          {
            _id: current._id,
            workspaceId,
            version: input.version,
            deletedAt: null,
            status: { $ne: 'rebuilding' },
          },
          {
            $set: {
              enabled: false,
              status: 'disabled',
              publishedFileVersion: null,
              pendingFileVersion: null,
              pendingJobId: null,
              pendingReason: null,
              pendingStartedAt: null,
              pendingSourceIds: [],
              lastError: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .lean<Plain<KnowledgeSynonymConfigDoc>>()
        .exec();
      if (!updated) throw conflict(context, { reason: 'config_cas', spaceId });
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.config.delete',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: {
              status: 'disabled',
              historicalFileVersion: updated.activeFileVersion,
            },
          }),
        ],
        { session },
      );
      return { id: String(updated._id), status: 'disabled', jobId: null };
    });
  }

  async listActiveSourceIds(spaceId: string, context: TenantContext): Promise<string[]> {
    const documents = await this.sources
      .find({
        workspaceId: requireWorkspaceId(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        searchEnabled: true,
        processingStatus: { $in: ['ready', 'partial'] },
        deletedAt: null,
      })
      .sort({ _id: 1 })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return documents.map((document) => String(document._id));
  }

  private async createRebuildJobInSession(input: {
    config: Plain<KnowledgeSynonymConfigDoc>;
    reason: SynonymRebuildReason;
    fileVersion: number;
    sourceIds: string[];
    expectedActiveFileVersion: number;
    context: TenantContext;
    session: ClientSession;
  }): Promise<S09SynonymJobView> {
    const idempotencyKey = rebuildIdempotencyKey({
      knowledgeSpaceId: String(input.config.knowledgeSpaceId),
      fileVersion: input.fileVersion,
      reason: input.reason,
    });
    const existing = await this.jobs
      .findOne({
        workspaceId: requireWorkspaceId(input.context),
        idempotencyKey,
        deletedAt: null,
      })
      .session(input.session)
      .lean<KnowledgeJobDoc & { _id: Types.ObjectId }>()
      .exec();
    if (existing) return jobView(existing);
    const now = new Date();
    const [created] = await this.jobs.create(
      [
        {
          workspaceId: requireWorkspaceId(input.context),
          knowledgeSpaceId: input.config.knowledgeSpaceId,
          version: 1,
          deletedAt: null,
          createdByMemberId: input.context.memberId,
          updatedByMemberId: input.context.memberId,
          kind: 'synonym_rebuild',
          resourceType: 'synonym',
          resourceId: String(input.config._id),
          status: 'queued',
          priority: 5,
          idempotencyKey,
          inputSnapshot: {
            fileVersion: input.fileVersion,
            expectedActiveFileVersion: input.expectedActiveFileVersion,
            sourceIds: input.sourceIds,
            indexedSegmentVersions: {},
            reason: input.reason,
          },
          progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
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
          expiresAt: new Date(now.getTime() + 180 * 86_400_000),
        },
      ],
      { session: input.session, ordered: true },
    );
    if (!created) throw tenantError(input.context);
    await createKnowledgeOutboxEvent(
      this.connection,
      {
        workspaceId: requireWorkspaceId(input.context),
        knowledgeSpaceId: String(input.config.knowledgeSpaceId),
        eventType: 'synonym_rebuild.job.queued',
        aggregateType: 'job',
        aggregateId: String(created._id),
        queue: 'knowledge-rebuild',
        payload: { jobId: String(created._id) },
      },
      input.context,
      input.session,
    );
    return jobView(created.toObject() as unknown as KnowledgeJobDoc & { _id: Types.ObjectId });
  }

  async createManualRebuild(
    spaceId: string,
    input: { version: number },
    context: TenantContext,
  ): Promise<S09SynonymJobView> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    return withMongoTransaction(this.connection, async (session) => {
      const current = await this.findConfigDocument(spaceId, context, session);
      if (!current) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { spaceId });
      if (current.version !== input.version) {
        throw conflict(context, { reason: 'version_conflict', expected: input.version });
      }
      if (!current.enabled || current.status === 'disabled') {
        throw conflict(context, { reason: 'synonym_disabled' });
      }
      if (current.status === 'rebuilding' || current.pendingJobId) {
        throw conflict(context, { reason: 'synonym_rebuild_in_progress' });
      }
      const fileVersion = current.publishedFileVersion ?? current.activeFileVersion;
      const sourceIds = await this.listActiveSourceIds(spaceId, context);
      const updated = await this.configs
        .findOneAndUpdate(
          {
            _id: current._id,
            workspaceId,
            version: input.version,
            deletedAt: null,
          },
          {
            $set: {
              status: 'rebuilding',
              pendingFileVersion: fileVersion,
              pendingReason: 'manual',
              pendingStartedAt: new Date(),
              pendingSourceIds: sourceIds,
              lastError: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<Plain<KnowledgeSynonymConfigDoc>>()
        .exec();
      if (!updated) throw conflict(context, { reason: 'config_cas', spaceId });
      const job = await this.createRebuildJobInSession({
        config: updated,
        reason: 'manual',
        fileVersion,
        sourceIds,
        expectedActiveFileVersion: current.activeFileVersion,
        context,
        session,
      });
      await this.configs.updateOne(
        { _id: current._id, workspaceId, version: updated.version },
        {
          $set: { pendingJobId: job.jobId, updatedByMemberId: context.memberId },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.rebuild.request',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: {
              fileVersion,
              reason: 'manual',
              sourceCount: sourceIds.length,
              jobId: job.jobId,
            },
          }),
        ],
        { session },
      );
      return job;
    });
  }

  async getRebuildPlan(jobId: string, context: TenantContext): Promise<SynonymRebuildPlan> {
    const workspaceId = requireWorkspaceId(context);
    const job = await this.jobs
      .findOne({
        _id: objectIdOf(jobId, context, 'jobId'),
        workspaceId,
        kind: 'synonym_rebuild',
        deletedAt: null,
      })
      .lean<KnowledgeJobDoc & { _id: Types.ObjectId }>()
      .exec();
    if (!job) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { jobId });
    const config = await this.configs
      .findOne({
        workspaceId,
        knowledgeSpaceId: job.knowledgeSpaceId,
        deletedAt: null,
      })
      .lean<Plain<KnowledgeSynonymConfigDoc>>()
      .exec();
    if (!config) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { jobId });
    const fileVersion = Number(job.inputSnapshot.fileVersion);
    const reason = String(job.inputSnapshot.reason ?? 'manual') as SynonymRebuildReason;
    const sourceIds = Array.isArray(job.inputSnapshot.sourceIds)
      ? [...new Set(job.inputSnapshot.sourceIds.map(String))].sort()
      : [];
    const binding = await this.bindings
      .findOne({
        workspaceId,
        knowledgeSpaceId: job.knowledgeSpaceId,
        modelType: 'embedding',
        status: 'active',
        deletedAt: null,
      })
      .lean<KnowledgeModelBindingDoc>()
      .exec();
    if (!binding) {
      throw validation(context, {
        field: 'modelBindings.embedding',
        reason: 'required_for_synonym_rebuild',
      });
    }
    const dimensionCapability = binding.requiredCapabilities.find((capability) =>
      /^dimension:(768|1024|1536|3072)$/.test(capability),
    );
    const targetDimension = Number(
      dimensionCapability?.split(':')[1] ?? binding.activeQueryDimension,
    ) as 768 | 1024 | 1536 | 3072;
    if (![768, 1024, 1536, 3072].includes(targetDimension)) {
      throw validation(context, {
        field: 'modelBindings.embedding.dimension',
        reason: 'canonical_dimension_required',
      });
    }
    const segments = await this.segments
      .find({
        workspaceId,
        knowledgeSpaceId: job.knowledgeSpaceId,
        sourceId: { $in: sourceIds.map((sourceId) => new Types.ObjectId(sourceId)) },
        indexStatus: 'indexed',
        deletedAt: null,
      })
      .select({ _id: 1, version: 1 })
      .lean<Array<{ _id: Types.ObjectId; version: number }>>()
      .exec();
    return buildRebuildPlan({
      jobId: String(job._id),
      workspaceId,
      knowledgeSpaceId: String(job.knowledgeSpaceId),
      reason,
      candidateFileVersion: fileVersion,
      expectedActiveFileVersion: Number(
        job.inputSnapshot.expectedActiveFileVersion ?? config.activeFileVersion,
      ),
      oldPublishedFileVersion: config.publishedFileVersion,
      sourceIds,
      indexedSegmentVersions: Object.fromEntries(
        segments.map((segment) => [String(segment._id), segment.version]),
      ),
      oldQueryModelId: binding.activeQueryModelId,
      oldQueryDimension: binding.activeQueryDimension,
      targetModelId: binding.modelId,
      targetDimension,
      idempotencyKey: job.idempotencyKey,
      startedAt: job.createdAt,
      ...(job.status === 'running' && job.leaseOwner
        ? {
            lease: {
              workerId: job.leaseOwner,
              fencingToken: String(job.fencingToken),
              attemptEpoch: job.attemptEpoch,
              jobVersion: job.version,
            },
          }
        : {}),
    });
  }

  async completeRebuild(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    result: SynonymRebuildResult,
    context: TenantContext,
  ): Promise<void> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(plan.knowledgeSpaceId, context, 'spaceId');
    await withMongoTransaction(this.connection, async (session) => {
      if (!plan.lease) {
        throw conflict(context, { reason: 'synonym_job_lease_required', jobId: plan.jobId });
      }
      const job = await this.jobs
        .findOneAndUpdate(
          {
            _id: objectIdOf(plan.jobId, context, 'jobId'),
            workspaceId,
            kind: 'synonym_rebuild',
            status: 'running',
            leaseOwner: plan.lease.workerId,
            fencingToken: plan.lease.fencingToken,
            attemptEpoch: plan.lease.attemptEpoch,
            version: plan.lease.jobVersion,
            leaseExpiresAt: { $gt: new Date() },
            deletedAt: null,
          },
          {
            $set: {
              status: 'succeeded',
              result,
              error: null,
              progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<KnowledgeJobDoc>()
        .exec();
      if (!job) throw conflict(context, { reason: 'synonym_job_commit_cas', jobId: plan.jobId });
      const currentConfig = await this.configs
        .findOne({
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          pendingFileVersion: plan.candidateFileVersion,
          pendingJobId: plan.jobId,
          deletedAt: null,
        })
        .session(session)
        .lean<KnowledgeSynonymConfigDoc>()
        .exec();
      if (!currentConfig) {
        throw conflict(context, { reason: 'synonym_publish_cas', jobId: plan.jobId });
      }
      const config = await this.configs
        .findOneAndUpdate(
          {
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            pendingFileVersion: plan.candidateFileVersion,
            pendingJobId: plan.jobId,
            deletedAt: null,
          },
          {
            $set: {
              activeFileVersion: plan.candidateFileVersion,
              publishedFileVersion: plan.candidateFileVersion,
              pendingFileVersion: null,
              pendingJobId: null,
              pendingReason: null,
              pendingStartedAt: null,
              pendingSourceIds: [],
              status: currentConfig.enabled ? 'active' : 'disabled',
              lastError: null,
              activeQueryModelId: plan.targetModelId,
              activeQueryDimension: plan.targetDimension,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<KnowledgeSynonymConfigDoc>()
        .exec();
      if (!config) throw conflict(context, { reason: 'synonym_publish_cas', jobId: plan.jobId });
      await this.bindings.updateOne(
        {
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          modelType: 'embedding',
          status: 'active',
          deletedAt: null,
        },
        {
          $set: {
            activeQueryModelId: plan.targetModelId,
            activeQueryDimension: plan.targetDimension,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.rebuild.complete',
            resourceId: plan.knowledgeSpaceId,
            outcome: 'succeeded',
            safeDiff: {
              jobId: plan.jobId,
              oldFileVersion: plan.oldPublishedFileVersion,
              newFileVersion: plan.candidateFileVersion,
              sourceCount: result.sourceIds.length,
              rebuiltCount: result.rebuiltCount,
              reusedVectorCount: result.reusedVectorCount,
              cleanupCandidateCount: result.cleanupCandidates.length,
            },
          }),
        ],
        { session },
      );
      await createKnowledgeOutboxEvent(
        this.connection,
        {
          workspaceId,
          knowledgeSpaceId: plan.knowledgeSpaceId,
          eventType: 'synonym_rebuild.cleanup_candidates',
          aggregateType: 'job',
          aggregateId: plan.jobId,
          queue: 'knowledge-cleanup',
          payload: {
            jobId: plan.jobId,
            retentionDays: 30,
            cleanupCandidates: result.cleanupCandidates,
          },
        },
        context,
        session,
      );
    });
  }

  async failRebuild(
    plan: SynonymRebuildPlan,
    input: {
      retryable: boolean;
      errorCode: string;
      failureEvidence: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<void> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(plan.knowledgeSpaceId, context, 'spaceId');
    await withMongoTransaction(this.connection, async (session) => {
      if (!plan.lease) {
        throw conflict(context, { reason: 'synonym_job_lease_required', jobId: plan.jobId });
      }
      const now = new Date();
      const job = await this.jobs
        .findOneAndUpdate(
          {
            _id: objectIdOf(plan.jobId, context, 'jobId'),
            workspaceId,
            kind: 'synonym_rebuild',
            status: 'running',
            leaseOwner: plan.lease.workerId,
            fencingToken: plan.lease.fencingToken,
            attemptEpoch: plan.lease.attemptEpoch,
            version: plan.lease.jobVersion,
            leaseExpiresAt: { $gt: new Date() },
            deletedAt: null,
          },
          {
            $set: {
              status: input.retryable ? 'retry_wait' : 'failed',
              availableAt: input.retryable ? new Date(now.getTime() + 5_000) : now,
              error: {
                code: input.errorCode,
                retryable: input.retryable,
              },
              result: {
                sourceIds: plan.sourceIds,
                indexedSegmentVersions: plan.indexedSegmentVersions,
                failureEvidence: input.failureEvidence,
                cleanupCandidates: [],
                oldVersions: {
                  publishedFileVersion: plan.oldPublishedFileVersion,
                  queryModelId: plan.oldQueryModelId,
                  queryDimension: plan.oldQueryDimension,
                },
                newVersions: {
                  publishedFileVersion: plan.candidateFileVersion,
                  queryModelId: plan.targetModelId,
                  queryDimension: plan.targetDimension,
                },
              },
              progress: {
                stage: input.retryable ? 'retry_wait' : 'failed',
                completed: 0,
                total: 1,
                percent: 0,
              },
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<KnowledgeJobDoc>()
        .exec();
      if (!job) {
        throw conflict(context, { reason: 'synonym_job_failure_cas', jobId: plan.jobId });
      }
      await this.configs.updateOne(
        {
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          pendingFileVersion: plan.candidateFileVersion,
          pendingJobId: plan.jobId,
          deletedAt: null,
        },
        {
          $set: {
            status: input.retryable ? 'rebuilding' : 'failed',
            ...(input.retryable
              ? {}
              : {
                  pendingFileVersion: null,
                  pendingJobId: null,
                  pendingReason: null,
                  pendingStartedAt: null,
                  pendingSourceIds: [],
                }),
            lastError: {
              code: input.errorCode,
              message: input.errorCode,
            },
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.audits.create(
        [
          auditDocument({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            context,
            action: 'synonym.rebuild.failed',
            resourceId: plan.knowledgeSpaceId,
            outcome: 'failed',
            safeDiff: {
              jobId: plan.jobId,
              errorCode: input.errorCode,
              retryable: input.retryable,
              retainedFileVersion: plan.oldPublishedFileVersion,
            },
          }),
        ],
        { session },
      );
    });
  }
}
