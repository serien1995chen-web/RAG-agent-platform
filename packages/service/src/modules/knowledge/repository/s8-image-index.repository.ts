import { createKnowledgeError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { S6SegmentRecord, S6SourceRecord } from '../application/s06-processing-ports';
import type {
  S8CaptionStatus,
  S8ImageIndexStorePort,
  S8ImageSegmentRecord,
  S8VectorStatus,
} from '../application/s8-image-deep.ports';

function segmentRecord(
  document: KnowledgeSegmentDoc & { _id: Types.ObjectId },
): S8ImageSegmentRecord {
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
    imageDescription: document.imageDescription,
    version: document.version,
  };
}

function statusOf(value: unknown): S8CaptionStatus {
  return value === 'indexed' || value === 'error' ? value : 'pending';
}

function vectorStatusOf(value: unknown): S8VectorStatus {
  return value === 'indexed' || value === 'error' ? value : 'pending';
}

export class S8ImageIndexRepository implements S8ImageIndexStorePort {
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly segments: Model<KnowledgeSegmentDoc>;

  constructor(connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.sources = models.KnowledgeSource;
    this.segments = models.KnowledgeSegment;
  }

  async ensureImageSegment(
    input: {
      source: S6SourceRecord;
      imageBlobRefId: string;
      order?: number;
      metadata?: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<S8ImageSegmentRecord> {
    if (input.source.kind !== 'image' && input.source.kind !== 'file') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          field: 'source.kind',
          expected: ['image', 'file'],
          actual: input.source.kind,
        },
      });
    }
    if (input.source.kind === 'file' && !input.metadata?.imageAssetId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'metadata.imageAssetId', reason: 'required_for_file_asset' },
      });
    }
    const sourceId = new Types.ObjectId(input.source.id);
    const knowledgeSpaceId = new Types.ObjectId(input.source.knowledgeSpaceId);
    const imageBlobRefId = new Types.ObjectId(input.imageBlobRefId);
    const order = input.order ?? 0;
    const workspaceId = requireWorkspaceId(context);
    const current = await this.segments
      .findOne({
        workspaceId,
        knowledgeSpaceId,
        sourceId,
        order,
        deletedAt: null,
      })
      .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
    if (current) {
      const sameVersion =
        current.sourceVersion === input.source.sourceVersion &&
        String(current.imageBlobRefId) === input.imageBlobRefId;
      const document = await this.segments
        .findOneAndUpdate(
          {
            _id: current._id,
            workspaceId,
            version: current.version,
            deletedAt: null,
          },
          sameVersion
            ? {
                $set: {
                  sourceVersion: input.source.sourceVersion,
                  searchEnabled: input.source.searchEnabled,
                  imageBlobRefId,
                  metadata: {
                    ...current.metadata,
                    ...(input.metadata ?? {}),
                  },
                  updatedByMemberId: context.memberId,
                },
                $inc: { version: 1 },
              }
            : {
                $set: {
                  sourceVersion: input.source.sourceVersion,
                  searchEnabled: input.source.searchEnabled,
                  imageBlobRefId,
                  question: '',
                  answer: '',
                  content: '',
                  fullTextTokens: '',
                  fullTextVersion: 0,
                  indexes: [],
                  indexStatus: 'pending',
                  indexErrorCode: null,
                  imageDescription: null,
                  metadata: {
                    captionStatus: 'pending',
                    vectorStatus: 'pending',
                    ...(input.metadata ?? {}),
                  },
                  updatedByMemberId: context.memberId,
                },
                $inc: { version: 1 },
              },
          { new: true },
        )
        .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
      if (!document) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'image_segment_version_changed', sourceId: input.source.id },
        });
      }
      return segmentRecord(document);
    }
    const document = await this.segments
      .findOneAndUpdate(
        {
          workspaceId,
          knowledgeSpaceId,
          sourceId,
          order,
          deletedAt: null,
        },
        {
          $set: {
            sourceVersion: input.source.sourceVersion,
            searchEnabled: input.source.searchEnabled,
            imageBlobRefId,
            metadata: {
              captionStatus: 'pending',
              vectorStatus: 'pending',
              ...(input.metadata ?? {}),
            },
            updatedByMemberId: context.memberId,
          },
          $setOnInsert: {
            workspaceId,
            knowledgeSpaceId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            sourceId,
            order,
            question: '',
            answer: '',
            content: '',
            fullTextTokens: '',
            fullTextVersion: 0,
            history: [],
            indexes: [],
            indexStatus: 'pending',
            indexErrorCode: null,
            imageDescription: null,
            synonymVersion: 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
    if (!document) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'image_segment_upsert_failed', sourceId: input.source.id },
      });
    }
    return segmentRecord(document);
  }

  async commit(
    input: {
      segmentId: string;
      expectedVersion: number;
      sourceVersion: number;
      imageBlobRefId: string;
      imageDescription: string;
      captionStatus: S8CaptionStatus;
      vectorStatus: S8VectorStatus;
      captionPromptVersion: string;
      visionEmbeddingModelId: string;
      captionKey: string;
      indexes: S6SegmentRecord['indexes'];
    },
    context: TenantContext,
  ): Promise<S8ImageSegmentRecord | null> {
    const anyIndexed = input.captionStatus === 'indexed' || input.vectorStatus === 'indexed';
    const document = await this.segments
      .findOneAndUpdate(
        {
          _id: input.segmentId,
          workspaceId: requireWorkspaceId(context),
          sourceVersion: input.sourceVersion,
          version: input.expectedVersion,
          imageBlobRefId: new Types.ObjectId(input.imageBlobRefId),
          deletedAt: null,
        },
        {
          $set: {
            question: input.imageDescription,
            answer: '',
            content: input.imageDescription,
            imageDescription: input.imageDescription,
            indexes: input.indexes,
            indexStatus: anyIndexed ? 'indexed' : 'error',
            indexErrorCode: anyIndexed ? null : 'KNOWLEDGE_MODEL_FAILED',
            'metadata.captionStatus': input.captionStatus,
            'metadata.vectorStatus': input.vectorStatus,
            'metadata.captionPromptVersion': input.captionPromptVersion,
            'metadata.visionEmbeddingModelId': input.visionEmbeddingModelId,
            'metadata.imageSourceVersion': input.sourceVersion,
            'metadata.captionKey': input.captionKey,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
    return document ? segmentRecord(document) : null;
  }

  async markFinalFailure(
    input: {
      sourceId: string;
      sourceVersion: number;
      imageBlobRefId: string;
    },
    context: TenantContext,
  ): Promise<void> {
    const current = await this.segments
      .findOne({
        workspaceId: requireWorkspaceId(context),
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        imageBlobRefId: input.imageBlobRefId,
        order: 0,
        deletedAt: null,
      })
      .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
    if (!current) return;
    const captionStatus = statusOf(current.metadata.captionStatus);
    const vectorStatus = vectorStatusOf(current.metadata.vectorStatus);
    await this.segments.updateOne(
      {
        _id: current._id,
        workspaceId: requireWorkspaceId(context),
        version: current.version,
        deletedAt: null,
      },
      {
        $set: {
          'metadata.captionStatus': captionStatus === 'indexed' ? 'indexed' : 'error',
          'metadata.vectorStatus': vectorStatus === 'indexed' ? 'indexed' : 'error',
          indexStatus:
            captionStatus === 'indexed' || vectorStatus === 'indexed' ? 'indexed' : 'error',
          indexErrorCode:
            captionStatus === 'indexed' || vectorStatus === 'indexed'
              ? null
              : 'KNOWLEDGE_MODEL_FAILED',
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
    );
  }

  async listImageSources(
    input: { knowledgeSpaceId: string; cursor?: string; limit: number },
    context: TenantContext,
  ) {
    const filter: Record<string, unknown> = {
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: new Types.ObjectId(input.knowledgeSpaceId),
      kind: 'image',
      deletedAt: null,
    };
    if (input.cursor) filter._id = { $lt: new Types.ObjectId(input.cursor) };
    const documents = await this.sources
      .find(filter)
      .sort({ _id: -1 })
      .limit(Math.max(1, Math.min(input.limit, 50)))
      .lean();
    return documents;
  }
}
