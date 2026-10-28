import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { ClientSession, Connection } from 'mongoose';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import type {
  S6ExternalProcessingPort,
  S6FullTextPort,
  S6ProcessingStorePort,
  S6VectorPort,
} from '../application/s06-processing-ports';
import type { ModelCatalogPort } from '../application/s5-model-ports';
import type { S09S6RebuildIndexPort, S09S6RebuildPort } from '../application/s09-synonym.ports';
import {
  cleanupAvailableAt,
  type SynonymRebuildPlan,
  type SynonymStagedRebuild,
} from '../domain/s09-synonym-rebuild';

export interface S09S6RebuildIndexDependencies {
  connection: Connection;
  store: S6ProcessingStorePort;
  vectors: S6VectorPort;
  fulltext: S6FullTextPort;
  processing: Pick<S6ExternalProcessingPort, 'embed'>;
  models: ModelCatalogPort;
  now?: () => Date;
}

interface StagedSegment {
  segmentId: string;
  sourceId: string;
  expectedVersion: number;
  nextVersion: number;
  index: {
    indexId: string;
    type: string;
    modelId: string;
    dimension: 768 | 1024 | 1536 | 3072;
    storageType: 'vector' | 'halfvec';
    vectorProfile: string;
    vectorId: string;
    text: string;
    version: number;
  };
  indexes: Array<{
    indexId: string;
    type: string;
    modelId: string;
    dimension: 768 | 1024 | 1536 | 3072;
    storageType: 'vector' | 'halfvec';
    vectorProfile: string;
    vectorId: string;
    text: string;
    version: number;
  }>;
  fullTextTokens: string;
  fullTextVersion: number;
  oldVectorId: string | null;
  oldVectorDimension: 768 | 1024 | 1536 | 3072 | null;
  vectorWritten?: boolean;
}

function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class S09S6RebuildIndexAdapter implements S09S6RebuildIndexPort {
  private readonly staging = new Map<string, SynonymStagedRebuild>();

  constructor(private readonly input: S09S6RebuildIndexDependencies) {}

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private async resolveModel(plan: SynonymRebuildPlan, context: TenantContext) {
    const catalog = await this.input.models.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const model = catalog.find(
      (candidate) =>
        candidate.modelId === plan.targetModelId &&
        candidate.type === 'embedding' &&
        candidate.authorized &&
        candidate.dimension === plan.targetDimension,
    );
    const dimension = model?.dimension ?? null;
    if (!model || dimension === null) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'embeddingModelId', reason: 'binding_required' },
      });
    }
    const profile = this.input.vectors
      .listProfiles()
      .find((candidate) => candidate.dimension === plan.targetDimension);
    if (!profile) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'dimension', actual: plan.targetDimension },
      });
    }
    return { model: { ...model, dimension }, profile };
  }

  async stage(input: {
    plan: SynonymRebuildPlan;
    context: TenantContext;
  }): Promise<SynonymStagedRebuild> {
    const { plan, context } = input;
    const { model, profile } = await this.resolveModel(plan, context);
    const segments: StagedSegment[] = [];
    for (const sourceId of plan.sourceIds) {
      const sourceSegments = await this.input.store.listSegmentsBySource(sourceId, context);
      for (const segment of sourceSegments) {
        if (segment.indexStatus !== 'indexed' || !segment.searchEnabled) continue;
        const existing =
          segment.indexes.find((index) => index.indexId === 'default') ?? segment.indexes[0];
        const indexId = existing?.indexId ?? 'default';
        const type = existing?.type ?? 'default';
        const text = existing?.text ?? segment.content;
        const nextVersion = segment.version + 1;
        if (!this.input.fulltext.prepare) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 's6_fulltext_prepare_missing' },
          });
        }
        const projection = this.input.fulltext.prepare({
          segmentId: segment.id,
          sourceVersion: segment.sourceVersion,
          indexVersion: nextVersion,
          question: segment.question,
          answer: segment.answer,
          content: segment.content,
          ...(typeof segment.metadata.title === 'string' ? { title: segment.metadata.title } : {}),
          searchEnabled: segment.searchEnabled,
        });
        const reusable =
          existing !== undefined &&
          existing.modelId === model.modelId &&
          existing.dimension === model.dimension &&
          existing.text === text &&
          existing.vectorId.length > 0;
        const index = {
          indexId,
          type,
          modelId: model.modelId,
          dimension: model.dimension,
          storageType: profile.storageType,
          vectorProfile: profile.tableName,
          vectorId: reusable ? existing.vectorId : '',
          text,
          version: nextVersion,
        };
        const indexes = [
          ...segment.indexes.filter((candidate) => candidate.indexId !== indexId),
          index,
        ];
        segments.push({
          segmentId: segment.id,
          sourceId: segment.sourceId,
          expectedVersion: segment.version,
          nextVersion,
          index,
          indexes,
          fullTextTokens: projection.fullTextTokens,
          fullTextVersion: projection.fullTextVersion,
          oldVectorId:
            !reusable && existing?.vectorId && existing.vectorId.length > 0
              ? existing.vectorId
              : null,
          oldVectorDimension:
            !reusable && existing?.vectorId && existing.vectorId.length > 0
              ? existing.dimension
              : null,
          vectorWritten: false,
        });
      }
    }
    const reusedVectorCount = segments.filter((segment) => segment.index.vectorId).length;
    const staged: SynonymStagedRebuild = {
      stagingId: `synonym-stage:${plan.jobId}:${randomUUID()}`,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: plan.knowledgeSpaceId,
      candidateFileVersion: plan.candidateFileVersion,
      sourceIds: [...plan.sourceIds],
      indexedSegmentVersions: Object.fromEntries(
        segments.map((segment) => [segment.segmentId, segment.nextVersion]),
      ),
      reusedVectorCount,
      rebuiltCount: segments.length - reusedVectorCount,
      segments,
      cleanupCandidates: [],
      failureEvidence: null,
    };
    this.staging.set(staged.stagingId, staged);
    return staged;
  }

  async reuseOrBuildVector(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
  }): Promise<SynonymStagedRebuild> {
    const segs = (input.staged.segments ?? []) as StagedSegment[];
    const cleanupAt = cleanupAvailableAt(this.now());
    for (const segment of segs) {
      if (segment.index.vectorId) continue;
      const vectors = await this.input.processing.embed(
        {
          modelId: input.plan.targetModelId,
          dimension: input.plan.targetDimension,
          texts: [segment.index.text],
          knowledgeSpaceId: input.plan.knowledgeSpaceId,
          sourceId: segment.sourceId,
        },
        input.context,
      );
      const vector = vectors[0];
      if (!vector) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_MODEL_FAILED',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          retryable: true,
          details: { reason: 'embedding_empty' },
        });
      }
      const written = await this.input.vectors.insert(
        [
          {
            workspaceId: input.context.workspaceId,
            knowledgeSpaceId: input.plan.knowledgeSpaceId,
            sourceId: segment.sourceId,
            segmentId: segment.segmentId,
            indexId: segment.index.indexId,
            embeddingModelId: input.plan.targetModelId,
            dimension: input.plan.targetDimension,
            vector,
            searchEnabled: true,
            contentHash: contentHashOf(segment.index.text),
            version: segment.nextVersion,
          },
        ],
        input.context,
      );
      const vectorId = written.vectorIds[0];
      if (!vectorId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { reason: 'synonym_vector_id_missing' },
        });
      }
      segment.index.vectorId = vectorId;
      segment.indexes = segment.indexes.map((index) =>
        index.indexId === segment.index.indexId ? segment.index : index,
      );
      segment.vectorWritten = true;
      if (segment.oldVectorId) {
        if (segment.oldVectorDimension) {
          input.staged.cleanupCandidates.push({
            vectorId: segment.oldVectorId,
            dimension: segment.oldVectorDimension,
            availableAt: cleanupAt,
          });
        }
      }
    }
    input.staged.segments = segs;
    this.staging.set(input.staged.stagingId, input.staged);
    return input.staged;
  }

  private async finalizeWithSession(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
    session: ClientSession;
  }): Promise<SynonymStagedRebuild> {
    const segments = (input.staged.segments ?? []) as StagedSegment[];
    if (!this.input.store.finalizeSynonymIndexesInSession) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { reason: 's6_synonym_finalize_missing' },
      });
    }
    const versions = await this.input.store.finalizeSynonymIndexesInSession(
      {
        segments: segments.map((segment) => ({
          segmentId: segment.segmentId,
          expectedVersion: segment.expectedVersion,
          indexes: segment.indexes,
          fullTextTokens: segment.fullTextTokens,
          fullTextVersion: segment.fullTextVersion,
          synonymVersion: input.plan.candidateFileVersion,
        })),
      },
      input.context,
      input.session,
    );
    return {
      ...input.staged,
      indexedSegmentVersions: versions,
    };
  }

  async finalize(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
  }): Promise<{
    indexedSegmentVersions: Record<string, number>;
    cleanupCandidates: SynonymStagedRebuild['cleanupCandidates'];
  }> {
    const finalized = await withMongoTransaction(this.input.connection, (session) =>
      this.finalizeWithSession({ ...input, session }),
    );
    return {
      indexedSegmentVersions: finalized.indexedSegmentVersions,
      cleanupCandidates: finalized.cleanupCandidates,
    };
  }

  finalizeInSession(input: {
    plan: SynonymRebuildPlan;
    staged: SynonymStagedRebuild;
    context: TenantContext;
    session: unknown;
  }): Promise<SynonymStagedRebuild> {
    return this.finalizeWithSession({
      ...input,
      session: input.session as ClientSession,
    });
  }

  async rollback(input: { stagingId: string; context: TenantContext }): Promise<void> {
    const staged = this.staging.get(input.stagingId);
    if (!staged) return;
    const byDimension = new Map<number, string[]>();
    for (const segment of (staged.segments ?? []) as StagedSegment[]) {
      if (!segment.vectorWritten || !segment.index.vectorId) continue;
      const ids = byDimension.get(segment.index.dimension) ?? [];
      ids.push(segment.index.vectorId);
      byDimension.set(segment.index.dimension, ids);
    }
    for (const [dimension, vectorIds] of byDimension) {
      if (!this.input.vectors.deleteByIds) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { reason: 's6_vector_delete_missing' },
        });
      }
      await this.input.vectors.deleteByIds(
        {
          workspaceId: input.context.workspaceId,
          dimension: dimension as 768 | 1024 | 1536 | 3072,
          vectorIds,
        },
        input.context,
      );
    }
    this.staging.delete(input.stagingId);
  }
}

export class S09SynonymS6Adapter implements S09S6RebuildPort {
  constructor(private readonly index: S09S6RebuildIndexPort) {}

  stageProfile(plan: SynonymRebuildPlan, context: TenantContext): Promise<SynonymStagedRebuild> {
    return this.index.stage({ plan, context });
  }

  reuseOrBuildVector(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild> {
    return this.index.reuseOrBuildVector({ plan, staged, context });
  }

  async finalize(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild> {
    const finalized = await this.index.finalize({ plan, staged, context });
    return {
      ...staged,
      indexedSegmentVersions: finalized.indexedSegmentVersions,
      cleanupCandidates: finalized.cleanupCandidates,
    };
  }

  finalizeInSession(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
    session: unknown,
  ): Promise<SynonymStagedRebuild> {
    return this.index.finalizeInSession({ plan, staged, context, session });
  }

  rollback(stagingId: string, context: TenantContext): Promise<void> {
    return this.index.rollback({ stagingId, context });
  }
}
