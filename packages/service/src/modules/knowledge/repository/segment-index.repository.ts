import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { Connection, Model, Types } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
  SegmentIndexValue,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { vectorProfileOfDimension } from '../../../shared/persistence/pgvector/ddl';
import { stableKnowledgeVectorId } from '../../../shared/persistence/pgvector/vector-repository';
import type { ModelCatalogPort } from '../application/s5-model-ports';
import type { KnowledgeJobExecutionRepository } from './job-execution.repository';

type Plain<T> = T & { _id: Types.ObjectId; version: number };

const INDEX_TYPES = ['default', 'custom', 'question', 'summary'] as const;
const INDEX_ID = /^[a-zA-Z0-9_-]{1,64}$/;

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

function segmentDto(document: Plain<KnowledgeSegmentDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    sourceId: String(document.sourceId),
    sourceVersion: document.sourceVersion,
    searchEnabled: document.searchEnabled,
    order: document.order,
    question: document.question,
    answer: document.answer,
    content: document.content,
    fullTextTokens: document.fullTextTokens,
    fullTextVersion: document.fullTextVersion,
    metadata: document.metadata,
    history: document.history,
    indexes: document.indexes,
    indexStatus: document.indexStatus,
    indexErrorCode: document.indexErrorCode,
    imageBlobRefId: document.imageBlobRefId ? String(document.imageBlobRefId) : null,
    version: document.version,
  };
}

export interface SegmentIndexUpsertInput {
  indexId: string;
  type: (typeof INDEX_TYPES)[number];
  text: string;
  modelId: string;
  version: number;
}

export class KnowledgeSegmentIndexRepository {
  private readonly segments: Model<KnowledgeSegmentDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;

  constructor(
    private readonly connection: Connection,
    private readonly jobs: KnowledgeJobExecutionRepository,
    private readonly models: ModelCatalogPort,
  ) {
    const registered = registerKnowledgeModels(connection);
    this.segments = registered.KnowledgeSegment;
    this.sources = registered.KnowledgeSource;
  }

  private async resolveIndex(
    segment: Plain<KnowledgeSegmentDoc>,
    input: SegmentIndexUpsertInput,
    nextVersion: number,
    context: TenantContext,
  ): Promise<SegmentIndexValue> {
    if (!INDEX_ID.test(input.indexId)) {
      throw validation(context, { field: 'indexId', pattern: INDEX_ID.source });
    }
    if (!INDEX_TYPES.includes(input.type)) {
      throw validation(context, { field: 'type' });
    }
    if (!input.text.trim()) throw validation(context, { field: 'text', reason: 'required' });
    const catalog = await this.models.listModels({
      workspaceId: requireWorkspaceId(context),
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const model = catalog.find(
      (candidate) =>
        candidate.modelId === input.modelId &&
        candidate.type === 'embedding' &&
        candidate.authorized &&
        candidate.dimension !== null,
    );
    if (!model || model.dimension === null) {
      throw validation(context, { field: 'modelId', reason: 'embedding_binding_required' });
    }
    const profile = vectorProfileOfDimension(model.dimension);
    if (!profile) throw validation(context, { field: 'dimension', actual: model.dimension });
    const contentHash = createHash('sha256').update(input.text, 'utf8').digest('hex');
    const vectorId = stableKnowledgeVectorId({
      workspaceId: String(segment.workspaceId),
      knowledgeSpaceId: String(segment.knowledgeSpaceId),
      sourceId: String(segment.sourceId),
      segmentId: String(segment._id),
      indexId: input.indexId,
      embeddingModelId: model.modelId,
      version: nextVersion,
      contentHash,
    });
    return {
      indexId: input.indexId,
      type: input.type,
      modelId: model.modelId,
      dimension: profile.dimension,
      storageType: profile.storageType,
      vectorProfile: profile.tableName,
      vectorId,
      text: input.text,
      version: nextVersion,
    };
  }

  async upsert(
    segmentId: string,
    input: SegmentIndexUpsertInput,
    mode: 'create' | 'update',
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const session = await this.connection.startSession();
    try {
      let created: Plain<KnowledgeSegmentDoc> | null = null;
      await session.withTransaction(async () => {
        const segment = await this.segments
          .findOne({
            _id: objectIdOf(segmentId, context, 'segmentId'),
            workspaceId,
            version: input.version,
            deletedAt: null,
          })
          .session(session)
          .lean<Plain<KnowledgeSegmentDoc>>();
        if (!segment) throw conflict(context, { reason: 'version_conflict', segmentId });
        const exists = segment.indexes.some((index) => index.indexId === input.indexId);
        if (mode === 'create' && exists) {
          throw conflict(context, { reason: 'index_exists', indexId: input.indexId });
        }
        if (mode === 'update' && !exists) {
          throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { indexId: input.indexId });
        }
        const nextVersion = segment.version + 1;
        const nextIndex = await this.resolveIndex(segment, input, nextVersion, context);
        const indexes =
          mode === 'create'
            ? [...segment.indexes, nextIndex]
            : segment.indexes.map((index) => (index.indexId === input.indexId ? nextIndex : index));
        const updated = await this.segments.findOneAndUpdate(
          {
            _id: segment._id,
            workspaceId,
            version: segment.version,
            deletedAt: null,
          },
          {
            $set: {
              indexes,
              indexStatus: 'pending',
              indexErrorCode: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        );
        if (!updated) throw conflict(context, { reason: 'segment_index_cas', segmentId });
        await this.jobs.createInSession(
          {
            kind: 'index',
            resourceType: 'segment',
            resourceId: segmentId,
            knowledgeSpaceId: String(segment.knowledgeSpaceId),
            inputSnapshot: {
              operation: mode,
              index: nextIndex,
              sourceVersion: segment.sourceVersion,
            },
            priority: 5,
            idempotencyKey: `index:${segmentId}:${input.indexId}:${nextVersion}`,
          },
          context,
          session,
        );
        created = updated.toObject() as unknown as Plain<KnowledgeSegmentDoc>;
      });
      if (!created) throw tenantError(context);
      return segmentDto(created);
    } finally {
      await session.endSession();
    }
  }

  async remove(
    segmentId: string,
    indexId: string,
    expectedVersion: number,
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const session = await this.connection.startSession();
    try {
      let jobId = '';
      await session.withTransaction(async () => {
        const segment = await this.segments
          .findOne({
            _id: objectIdOf(segmentId, context, 'segmentId'),
            workspaceId,
            version: expectedVersion,
            deletedAt: null,
          })
          .session(session);
        if (!segment) throw conflict(context, { reason: 'version_conflict', segmentId });
        const index = segment.indexes.find((candidate) => candidate.indexId === indexId);
        if (!index) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { indexId });
        const job = await this.jobs.createInSession(
          {
            kind: 'index',
            resourceType: 'segment',
            resourceId: segmentId,
            knowledgeSpaceId: String(segment.knowledgeSpaceId),
            inputSnapshot: {
              operation: 'delete',
              index,
              expectedVersion,
              sourceVersion: segment.sourceVersion,
            },
            priority: 5,
            idempotencyKey: `delete-index:${segmentId}:${indexId}:${expectedVersion}`,
          },
          context,
          session,
        );
        jobId = job.jobId;
        await this.segments.updateOne(
          { _id: segment._id, workspaceId, version: segment.version },
          {
            $set: {
              indexStatus: 'rebuilding',
              indexErrorCode: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
      });
      return { id: segmentId, status: 'accepted', jobId: jobId || null };
    } finally {
      await session.endSession();
    }
  }

  async reindex(
    segmentId: string,
    input: {
      reason: 'manual' | 'model_change' | 'synonym_change' | 'repair';
      modelId?: string;
      version: number;
    },
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const session = await this.connection.startSession();
    try {
      let jobId = '';
      await session.withTransaction(async () => {
        const segment = await this.segments
          .findOne({
            _id: objectIdOf(segmentId, context, 'segmentId'),
            workspaceId,
            version: input.version,
            deletedAt: null,
          })
          .session(session)
          .lean<Plain<KnowledgeSegmentDoc>>();
        if (!segment) throw conflict(context, { reason: 'version_conflict', segmentId });
        const job = await this.jobs.createInSession(
          {
            kind: 'index',
            resourceType: 'segment',
            resourceId: segmentId,
            knowledgeSpaceId: String(segment.knowledgeSpaceId),
            inputSnapshot: {
              operation: 'reindex',
              reason: input.reason,
              modelId: input.modelId ?? null,
              sourceVersion: segment.sourceVersion,
              expectedVersion: input.version,
            },
            priority: 5,
            idempotencyKey: `reindex:${segmentId}:${input.version}:${input.reason}:${input.modelId ?? ''}`,
          },
          context,
          session,
        );
        jobId = job.jobId;
        await this.segments.updateOne(
          { _id: segment._id, workspaceId, version: segment.version },
          {
            $set: {
              indexStatus: 'rebuilding',
              indexErrorCode: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
      });
      const job = await this.jobs.getRaw(jobId, context);
      return {
        jobId,
        workspaceId: job.workspaceId,
        knowledgeSpaceId: String(job.knowledgeSpaceId),
        kind: job.kind,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
        status: job.status,
        priority: job.priority,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        progress: job.progress,
        version: job.version,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      };
    } finally {
      await session.endSession();
    }
  }

  async history(segmentId: string, context: TenantContext) {
    const segment = await this.segments
      .findOne({
        _id: objectIdOf(segmentId, context, 'segmentId'),
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeSegmentDoc>>();
    if (!segment) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { segmentId });
    return {
      items: [...segment.history]
        .sort(
          (left, right) =>
            new Date(String(right.changedAt ?? 0)).getTime() -
            new Date(String(left.changedAt ?? 0)).getTime(),
        )
        .slice(0, 20),
    };
  }
}
