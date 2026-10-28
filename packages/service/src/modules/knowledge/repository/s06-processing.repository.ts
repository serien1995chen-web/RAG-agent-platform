import type { Connection, Model, Types } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import {
  objectIdOf,
  requireWorkspaceId,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import type {
  KnowledgeSourceStatus,
  S6ProcessingStorePort,
  S6SegmentRecord,
  S6SourceRecord,
} from '../application/s06-processing-ports';

function sourceRecord(
  document: KnowledgeSourceDoc & { _id: { toString(): string } },
): S6SourceRecord {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    kind: document.kind,
    sourceVersion: document.sourceVersion,
    blobRefId: document.blobRefId ? String(document.blobRefId) : null,
    name: document.name,
    mimeType: document.mimeType,
    parseProvider: document.parseProvider,
    searchEnabled: document.searchEnabled,
    processingStatus: document.processingStatus,
    version: document.version,
  };
}

function segmentRecord(
  document: KnowledgeSegmentDoc & { _id: { toString(): string } },
): S6SegmentRecord {
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

export class S6ProcessingRepository implements S6ProcessingStorePort {
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly segments: Model<KnowledgeSegmentDoc>;

  constructor(connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.sources = models.KnowledgeSource;
    this.segments = models.KnowledgeSegment;
  }

  async getSource(sourceId: string, context: TenantContext) {
    const document = await this.sources
      .findOne({
        _id: sourceId,
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      })
      .lean<KnowledgeSourceDoc & { _id: Types.ObjectId }>();
    return document ? sourceRecord(document) : null;
  }

  async getSegment(segmentId: string, context: TenantContext) {
    const document = await this.segments
      .findOne({
        _id: segmentId,
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      })
      .lean<KnowledgeSegmentDoc & { _id: Types.ObjectId }>();
    return document ? segmentRecord(document) : null;
  }

  async listSegmentsBySource(sourceId: string, context: TenantContext) {
    const documents = await this.segments
      .find({
        workspaceId: requireWorkspaceId(context),
        sourceId,
        deletedAt: null,
      })
      .sort({ order: 1 })
      .lean<Array<KnowledgeSegmentDoc & { _id: Types.ObjectId }>>();
    return documents.map(segmentRecord);
  }

  async listActiveWorkspaceSegments(context: TenantContext) {
    const documents = await this.segments
      .find({ workspaceId: requireWorkspaceId(context), deletedAt: null })
      .lean<Array<KnowledgeSegmentDoc & { _id: Types.ObjectId }>>();
    return documents.map(segmentRecord);
  }

  async updateSourcesStatus(
    sourceIds: readonly string[],
    status: KnowledgeSourceStatus,
    context: TenantContext,
  ) {
    await this.sources.updateMany(
      {
        _id: { $in: sourceIds },
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      },
      {
        $set: { processingStatus: status, updatedByMemberId: context.memberId },
        $inc: { version: 1 },
      },
    );
  }

  async updateSourceStatus(
    sourceId: string,
    status: KnowledgeSourceStatus,
    context: TenantContext,
    sourceVersion?: number,
  ) {
    await this.sources.updateOne(
      {
        _id: sourceId,
        workspaceId: requireWorkspaceId(context),
        ...(sourceVersion !== undefined ? { sourceVersion } : {}),
        deletedAt: null,
      },
      {
        $set: { processingStatus: status, updatedByMemberId: context.memberId },
        $inc: { version: 1 },
      },
    );
  }

  async upsertParsedSegments(
    input: {
      source: S6SourceRecord;
      sourceVersion: number;
      rows: ReadonlyArray<{
        order: number;
        question: string;
        answer: string;
        content: string;
        metadata?: Record<string, unknown>;
      }>;
    },
    context: TenantContext,
  ) {
    const sourceId = objectIdOf(input.source.id, context, 'sourceId');
    const knowledgeSpaceId = objectIdOf(input.source.knowledgeSpaceId, context, 'knowledgeSpaceId');
    const segmentIds: string[] = [];
    for (const row of input.rows) {
      const segment = await this.segments.findOneAndUpdate(
        {
          workspaceId: requireWorkspaceId(context),
          knowledgeSpaceId,
          sourceId,
          order: row.order,
          deletedAt: null,
        },
        {
          $set: {
            sourceVersion: input.sourceVersion,
            searchEnabled: input.source.searchEnabled,
            question: row.question,
            answer: row.answer,
            content: row.content,
            metadata: input.rows.find((row) => row.order === segmentIds.length)?.metadata ?? {},
            indexStatus: 'pending',
            indexErrorCode: null,
            updatedByMemberId: context.memberId,
          },
          $setOnInsert: {
            workspaceId: requireWorkspaceId(context),
            knowledgeSpaceId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            sourceId,
            fullTextTokens: '',
            fullTextVersion: 0,
            history: [],
            indexes: [],
            imageBlobRefId: null,
            imageDescription: null,
            synonymVersion: 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (segment) segmentIds.push(String(segment._id));
    }
    return segmentIds;
  }

  async softDeleteSegmentsAfterOrder(sourceId: string, order: number, context: TenantContext) {
    await this.segments.updateMany(
      {
        workspaceId: requireWorkspaceId(context),
        sourceId,
        order: { $gte: order },
        imageBlobRefId: null,
        deletedAt: null,
      },
      {
        $set: { deletedAt: new Date(), updatedByMemberId: context.memberId },
        $inc: { version: 1 },
      },
    );
  }

  async markIndexFailure(segmentId: string, errorCode: string, context: TenantContext) {
    await this.segments.updateOne(
      { _id: segmentId, workspaceId: requireWorkspaceId(context), deletedAt: null },
      {
        $set: {
          indexStatus: 'error',
          indexErrorCode: errorCode,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
    );
  }

  async removeSegmentIndex(
    segmentId: string,
    expectedVersion: number,
    indexId: string | undefined,
    context: TenantContext,
  ) {
    const segment = await this.getSegment(segmentId, context);
    if (!segment) return null;
    const indexes = segment.indexes.filter((index) => index.indexId !== indexId);
    const updated = await this.segments.findOneAndUpdate(
      {
        _id: segmentId,
        workspaceId: requireWorkspaceId(context),
        version: expectedVersion,
        deletedAt: null,
      },
      {
        $set: {
          indexes,
          indexStatus: indexes.length ? 'indexed' : 'pending',
          indexErrorCode: null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return updated
      ? segmentRecord(updated.toObject() as KnowledgeSegmentDoc & { _id: Types.ObjectId })
      : null;
  }

  async switchSegmentIndex(
    input: {
      segmentId: string;
      expectedVersion: number;
      fullTextVersion: number;
      indexes: KnowledgeSegmentDoc['indexes'];
    },
    context: TenantContext,
  ) {
    const updated = await this.segments.findOneAndUpdate(
      {
        _id: input.segmentId,
        workspaceId: requireWorkspaceId(context),
        version: input.expectedVersion,
        fullTextVersion: input.fullTextVersion,
        deletedAt: null,
      },
      {
        $set: {
          indexes: input.indexes,
          indexStatus: 'indexed',
          indexErrorCode: null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return updated
      ? segmentRecord(updated.toObject() as KnowledgeSegmentDoc & { _id: Types.ObjectId })
      : null;
  }

  async updateSegmentQa(
    segmentId: string,
    expectedVersion: number,
    qa: { question: string; answer: string; content: string },
    context: TenantContext,
  ) {
    const updated = await this.segments.findOneAndUpdate(
      {
        _id: segmentId,
        workspaceId: requireWorkspaceId(context),
        version: expectedVersion,
        deletedAt: null,
      },
      {
        $set: {
          question: qa.question,
          answer: qa.answer,
          content: qa.content,
          indexStatus: 'pending',
          indexErrorCode: null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return updated
      ? segmentRecord(updated.toObject() as KnowledgeSegmentDoc & { _id: Types.ObjectId })
      : null;
  }

  async softDeleteSegments(
    filter: { resourceType: 'source' | 'segment'; resourceId: string },
    context: TenantContext,
  ) {
    const result = await this.segments.updateMany(
      {
        workspaceId: requireWorkspaceId(context),
        ...(filter.resourceType === 'segment'
          ? { _id: filter.resourceId }
          : { sourceId: filter.resourceId }),
        deletedAt: null,
      },
      {
        $set: { deletedAt: new Date(), updatedByMemberId: context.memberId },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount;
  }
}
