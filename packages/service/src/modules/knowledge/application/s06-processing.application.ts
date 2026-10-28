import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { ChunkingSettings } from '@kb/chunk';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  S6ArtifactPort,
  S6ExternalProcessingPort,
  S6FullTextPort,
  S6JobPort,
  S6JobRecord,
  S6ProcessingStorePort,
  S6SegmentRecord,
  S6ConnectorSyncPort,
  S6VectorPort,
} from './s06-processing-ports';
import { tenantError } from '../../../shared/persistence/knowledge/tenant';
import type { S5ProcessingApplication } from './s5-processing.application';
import type { ModelBindingRepositoryPort, ModelCatalogPort } from './s5-model-ports';
import type { S8CaptionExecutorPort } from './s8-image-deep.ports';
import type { S09RebuildApplication } from './s09-rebuild.application';

export type S6ProcessingPort = S6ExternalProcessingPort;

type QueueName =
  | 'knowledge-import'
  | 'knowledge-parse'
  | 'knowledge-segment'
  | 'knowledge-qa'
  | 'knowledge-ocr'
  | 'knowledge-caption'
  | 'knowledge-embed'
  | 'knowledge-index'
  | 'knowledge-rebuild'
  | 'knowledge-sync'
  | 'knowledge-delete'
  | 'knowledge-outbox'
  | 'knowledge-cleanup';

type JobKind = S6JobRecord['kind'];

const QUEUE_KINDS: Readonly<Record<QueueName, readonly JobKind[]>> = {
  'knowledge-import': ['import'],
  'knowledge-parse': ['parse'],
  'knowledge-segment': ['segment'],
  'knowledge-qa': ['qa'],
  'knowledge-ocr': ['ocr'],
  'knowledge-caption': ['caption'],
  'knowledge-embed': ['embed'],
  'knowledge-index': ['index', 'fulltext'],
  'knowledge-rebuild': ['rebuild'],
  'knowledge-sync': ['sync'],
  'knowledge-delete': ['delete'],
  'knowledge-outbox': ['outbox'],
  'knowledge-cleanup': ['cleanup'],
};

function parseSourceIds(job: S6JobRecord) {
  const sourceIds = Array.isArray(job.inputSnapshot.sourceIds)
    ? [...new Set(job.inputSnapshot.sourceIds.map(String))]
    : [];
  if (sourceIds.length === 0) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: `job:${job._id}`,
      traceId: `job:${job._id}`,
      details: { field: 'inputSnapshot.sourceIds' },
    });
  }
  return sourceIds;
}

function isRetryable(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    (error as { problem?: { error?: { retryable?: unknown } } }).problem?.error?.retryable,
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
  ) {
    return String((error as { problem: { error: { code: string } } }).problem.error.code);
  }
  return 'KNOWLEDGE_INTERNAL_ERROR';
}

export class S06ProcessingApplication {
  constructor(
    private readonly input: {
      jobs: S6JobPort;
      store: S6ProcessingStorePort;
      artifacts: S6ArtifactPort;
      processing: S5ProcessingApplication;
      vectors: S6VectorPort;
      fulltext: S6FullTextPort;
      models: ModelCatalogPort;
      bindings: Pick<ModelBindingRepositoryPort, 'list'>;
      port: S6ProcessingPort;
      sync?: S6ConnectorSyncPort;
      caption?: S8CaptionExecutorPort;
      synonymRebuild?: Pick<S09RebuildApplication, 'handleQueue'>;
      synonymVersion?: {
        getPublishedFileVersion(spaceId: string, context: TenantContext): Promise<number>;
      };
    },
  ) {}

  hydrateOutbox(outboxEventId: string, context: TenantContext) {
    return this.input.jobs.hydrateOutbox(outboxEventId, context);
  }

  recoverExpiredLeases(context: TenantContext) {
    return this.input.jobs.recoverExpiredLeases(context);
  }

  private async completeConnectorRoot(rootJobId: string, context: TenantContext) {
    if (!this.input.sync) return;
    let root: S6JobRecord;
    try {
      root = await this.input.jobs.getRaw(rootJobId, context);
    } catch {
      return;
    }
    if (
      root.kind !== 'sync' ||
      root.resourceType !== 'connector' ||
      !['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(root.status)
    ) {
      return;
    }
    await this.input.sync.complete(
      {
        connectorId: root.resourceId,
        success: root.status === 'succeeded',
        ...(typeof root.error?.code === 'string' ? { errorCode: root.error.code } : {}),
      },
      context,
    );
  }

  requeueDueRetries(context: TenantContext) {
    return this.input.jobs.requeueDueRetries(context);
  }

  embedForIndex(input: Parameters<S6ExternalProcessingPort['embed']>[0], context: TenantContext) {
    return this.input.port.embed(input, context);
  }

  private async refreshSourceIndexStatus(sourceId: string, context: TenantContext) {
    const segments = await this.input.store.listSegmentsBySource(sourceId, context);
    const status = segments.some((segment) =>
      ['pending', 'indexing', 'rebuilding'].includes(segment.indexStatus),
    )
      ? 'indexing'
      : segments.some(
            (segment) =>
              ['error', 'rebuild_failed'].includes(segment.indexStatus) ||
              segment.metadata.captionStatus === 'error' ||
              segment.metadata.vectorStatus === 'error' ||
              segment.metadata.enhancementPartial === true,
          )
        ? 'partial'
        : segments.length > 0 && segments.every((segment) => segment.indexStatus === 'indexed')
          ? 'ready'
          : 'failed';
    await this.input.store.updateSourceStatus(sourceId, status, context);
    return status;
  }

  private async withJob<T>(
    queue: QueueName,
    jobId: string,
    workerId: string,
    context: TenantContext,
    work: (
      job: S6JobRecord,
    ) => Promise<{ result: Record<string, unknown>; value: T; waitingForChildren?: boolean }>,
  ): Promise<{ outcome: 'succeeded' | 'retry' | 'dead_letter'; jobId: string; value?: T }> {
    const raw = await this.input.jobs.getRaw(jobId, context);
    if (['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(raw.status)) {
      const rootJobId = String(raw.inputSnapshot.rootJobId ?? raw._id);
      await this.input.jobs.aggregateRoot(rootJobId, context);
      await this.completeConnectorRoot(rootJobId, context);
      return { outcome: raw.status === 'succeeded' ? 'succeeded' : 'dead_letter', jobId };
    }
    const claimed = await this.input.jobs.claimById(
      { jobId, kinds: QUEUE_KINDS[queue], workerId },
      context,
    );
    if (!claimed) {
      const rootJobId = String(raw.inputSnapshot.rootJobId ?? raw._id);
      await this.input.jobs.aggregateRoot(rootJobId, context);
      await this.completeConnectorRoot(rootJobId, context);
      return { outcome: 'retry', jobId };
    }
    const claimedRaw = await this.input.jobs.getRaw(jobId, context);
    const fencingToken = String(claimedRaw.fencingToken);
    const attemptEpoch = Number(claimedRaw.attemptEpoch);
    let current = await this.input.jobs.start(
      jobId,
      Number(claimed.version),
      attemptEpoch,
      fencingToken,
      workerId,
      context,
    );
    const heartbeat = setInterval(() => {
      void this.input.jobs
        .heartbeat(jobId, Number(current.version), attemptEpoch, fencingToken, workerId, context)
        .then((next) => {
          current = next;
        })
        .catch(() => undefined);
    }, 60_000);
    try {
      const job = await this.input.jobs.getRaw(jobId, context);
      const completed = await work(job);
      if (!completed.waitingForChildren) {
        await this.input.jobs.commit(
          jobId,
          Number(current.version),
          attemptEpoch,
          fencingToken,
          workerId,
          completed.result,
          context,
        );
      }
      const rootJobId = String(job.inputSnapshot.rootJobId ?? job._id);
      await this.input.jobs.aggregateRoot(rootJobId, context);
      await this.completeConnectorRoot(rootJobId, context);
      return { outcome: 'succeeded', jobId, value: completed.value };
    } catch (error) {
      const failed = await this.input.jobs.fail(
        jobId,
        Number(current.version),
        attemptEpoch,
        fencingToken,
        workerId,
        isRetryable(error),
        errorCode(error),
        context,
      );
      if (queue === 'knowledge-caption' && failed.status !== 'retry_wait' && this.input.caption) {
        await this.input.caption.markFinalFailure(raw, context).catch(() => undefined);
      }
      if (queue === 'knowledge-index' && failed.status !== 'retry_wait') {
        try {
          const segment = await this.input.store.getSegment(jobId, context);
          if (segment) {
            await this.input.store.markIndexFailure(segment.id, errorCode(error), context);
            await this.refreshSourceIndexStatus(segment.sourceId, context);
          }
        } catch {
          // Preserve the original fenced Job failure when status projection fails.
        }
      }
      const rootJobId = String(raw.inputSnapshot.rootJobId ?? raw._id);
      await this.input.jobs.aggregateRoot(rootJobId, context);
      await this.completeConnectorRoot(rootJobId, context);
      return {
        outcome: failed.status === 'dead_letter' ? 'dead_letter' : 'retry',
        jobId,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async handleImport(
    outboxEventId: string,
    workerId: string,
    context: TenantContext,
  ): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    const event = await this.input.jobs.hydrateOutbox(outboxEventId, context);
    if (event.eventType !== 'import.submit') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { eventType: event.eventType, expected: 'import.submit' },
      });
    }
    const parentJobId = String(event.payload.parentJobId ?? event.aggregateId);
    const parent = await this.input.jobs.getRaw(parentJobId, context);
    const sourceIds = parseSourceIds(parent);
    const transported = Array.isArray(event.payload.sourceIds)
      ? event.payload.sourceIds.map(String)
      : [];
    if (transported.length > 0 && transported.join('|') !== sourceIds.join('|')) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'outbox_payload_mismatch' },
      });
    }
    if (['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(parent.status)) {
      return parent.status === 'succeeded' ? 'succeeded' : 'dead_letter';
    }
    if (parent.status === 'running') {
      const aggregate = await this.input.jobs.aggregateRoot(parentJobId, context);
      return aggregate?.status === 'succeeded' ? 'succeeded' : 'retry';
    }
    const claimed = await this.input.jobs.claimById(
      { jobId: parentJobId, kinds: ['import'], workerId },
      context,
    );
    if (!claimed) return 'retry';
    const claimedRaw = await this.input.jobs.getRaw(parentJobId, context);
    const fencingToken = claimedRaw.fencingToken;
    const attemptEpoch = claimedRaw.attemptEpoch;
    const current = await this.input.jobs.start(
      parentJobId,
      claimed.version,
      attemptEpoch,
      fencingToken,
      workerId,
      context,
    );
    try {
      const job = await this.input.jobs.getRaw(parentJobId, context);
      await this.input.jobs.setStep(
        {
          jobId: parentJobId,
          stepKey: 'hydrate',
          status: 'succeeded',
          idempotencyKey: `hydrate:${event.eventKey}`,
          evidence: { eventKey: event.eventKey, sourceCount: sourceIds.length },
        },
        context,
      );
      const childJobIds: string[] = [];
      const parseSourceIds: string[] = [];
      const imageSourceIds: string[] = [];
      for (const sourceId of sourceIds) {
        const source = await this.input.store.getSource(sourceId, context);
        if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId });
        const image = source.kind === 'image';
        const child = await this.input.jobs.createChild(
          {
            kind: image ? 'caption' : 'parse',
            resourceType: 'source',
            resourceId: sourceId,
            knowledgeSpaceId: source.knowledgeSpaceId,
            inputSnapshot: {
              sourceId,
              sourceVersion: source.sourceVersion,
              imageBlobRefId: image ? source.blobRefId : null,
              parseProvider: source.parseProvider,
              configHash: String(job.inputSnapshot.configurationHash ?? ''),
              chunking: job.inputSnapshot.chunking ?? {
                trainingType: 'chunk',
                chunkSettingMode: 'auto',
              },
              rootJobId: parentJobId,
              parentJobId,
            },
            rootJobId: parentJobId,
            parentJobId,
            priority: job.priority,
            idempotencyKey: `${parentJobId}:${sourceId}:${source.sourceVersion}:${image ? 'caption' : 'parse'}`,
          },
          context,
        );
        childJobIds.push(child.jobId);
        (image ? imageSourceIds : parseSourceIds).push(sourceId);
      }
      if (parseSourceIds.length > 0) {
        await this.input.store.updateSourcesStatus(parseSourceIds, 'parsing', context);
      }
      if (imageSourceIds.length > 0) {
        await this.input.store.updateSourcesStatus(imageSourceIds, 'indexing', context);
      }
      await this.input.jobs.setStep(
        {
          jobId: parentJobId,
          stepKey: 'fan-out',
          status: 'succeeded',
          idempotencyKey: `fan-out:${parentJobId}`,
          evidence: { childJobIds, imageSourceIds, parseSourceIds },
        },
        context,
      );
      await this.input.jobs.releaseWaitingForChildren(parentJobId, childJobIds, context);
      return 'succeeded';
    } catch (error) {
      const failed = await this.input.jobs.fail(
        parentJobId,
        current.version,
        attemptEpoch,
        fencingToken,
        workerId,
        isRetryable(error),
        errorCode(error),
        context,
      );
      return failed.status === 'dead_letter' ? 'dead_letter' : 'retry';
    }
  }

  private async processParse(job: S6JobRecord, context: TenantContext) {
    const sourceId = String(job.inputSnapshot.sourceId ?? job.resourceId);
    const source = await this.input.store.getSource(sourceId, context);
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId });
    if (!source.blobRefId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { sourceId, reason: 'blob_ref_missing' },
      });
    }
    const parsed = await this.input.port.parse(
      {
        sourceId,
        blobRefId: String(source.blobRefId),
        knowledgeSpaceId: source.knowledgeSpaceId,
        sourceVersion: Number(job.inputSnapshot.sourceVersion ?? source.sourceVersion),
        fileName: source.name,
        mimeType: source.mimeType,
        parseProvider: String(job.inputSnapshot.parseProvider ?? source.parseProvider),
      },
      context,
    );
    if (!parsed.rawText.trim()) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { sourceId, reason: 'empty_raw_text' },
      });
    }
    await this.input.jobs.setStep(
      {
        jobId: String(job._id),
        stepKey: 'parse',
        status: 'running',
        idempotencyKey: `${sourceId}:${source.sourceVersion}:${source.parseProvider}:${parsed.configHash}`,
      },
      context,
    );
    const artifact = await this.input.artifacts.materialize(
      {
        sourceId,
        sourceVersion: Number(job.inputSnapshot.sourceVersion ?? source.sourceVersion),
        knowledgeSpaceId: source.knowledgeSpaceId,
        parse: parsed,
      },
      context,
    );
    const processed = await this.input.processing.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: source.knowledgeSpaceId,
      sourceId,
      sourceName: source.name,
      sourceVersion: artifact.sourceVersion,
      rawText: parsed.rawText,
      artifact,
      settings: job.inputSnapshot.chunking as ChunkingSettings,
      context,
    });
    const qaByHash = new Map(processed.qaItems.map((item) => [item.sourceChunkHash, item]));
    const rows: Array<{
      order: number;
      question: string;
      answer: string;
      content: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const chunking = job.inputSnapshot.chunking as ChunkingSettings | undefined;
    const enhancementMetadata =
      processed.evidence.partial === true ? { enhancementPartial: true } : undefined;
    for (const chunk of processed.chunks) {
      const qaItems = processed.qaItems.filter(
        (item) => item.sourceChunkHash === chunk.contentHash,
      );
      if (qaItems.length === 0 || chunking?.trainingType === 'chunk') {
        rows.push({
          order: rows.length,
          question: chunk.text,
          answer: chunk.text,
          content: chunk.text,
          ...(enhancementMetadata ? { metadata: enhancementMetadata } : {}),
        });
      }
      if (qaItems.length > 0) {
        for (const item of qaItems) {
          rows.push({
            order: rows.length,
            question: item.q,
            answer: item.a,
            content: `${item.q}\n${item.a}`.trim(),
            ...(enhancementMetadata ? { metadata: enhancementMetadata } : {}),
          });
        }
      }
    }
    if (rows.length === 0) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'empty_segments' },
      });
    }
    const segmentIds = await this.input.store.upsertParsedSegments(
      { source, sourceVersion: artifact.sourceVersion, rows },
      context,
    );
    await this.input.store.softDeleteSegmentsAfterOrder(sourceId, rows.length, context);
    const rootJobId = String(job.inputSnapshot.rootJobId ?? job._id);
    const indexJobIds: string[] = [];
    for (const segmentId of segmentIds) {
      const child = await this.input.jobs.createChild(
        {
          kind: 'index',
          resourceType: 'segment',
          resourceId: segmentId,
          knowledgeSpaceId: source.knowledgeSpaceId,
          inputSnapshot: {
            operation: 'index',
            sourceVersion: artifact.sourceVersion,
            rootJobId,
            parentJobId: String(job._id),
          },
          rootJobId,
          parentJobId: String(job._id),
          priority: job.priority,
          idempotencyKey: `${job._id}:${segmentId}:${artifact.sourceVersion}:index`,
        },
        context,
      );
      indexJobIds.push(child.jobId);
    }
    await this.input.store.updateSourceStatus(
      sourceId,
      'indexing',
      context,
      artifact.sourceVersion,
    );
    await this.input.jobs.setStep(
      {
        jobId: String(job._id),
        stepKey: 'persist-segments',
        status: 'succeeded',
        idempotencyKey: `segments:${sourceId}:${artifact.sourceVersion}`,
        evidence: {
          segmentIds,
          parserVersion: processed.evidence.parserVersion,
          rawTextHash: processed.evidence.rawTextHash,
          chunkingConfigHash: processed.evidence.chunkingConfigHash,
          qaPromptVersion: processed.evidence.qaPromptVersion,
          qaCount: qaByHash.size,
          fallbackUsed: processed.evidence.fallbackUsed,
        },
      },
      context,
    );
    await this.input.jobs.releaseWaitingForChildren(String(job._id), indexJobIds, context, {
      segmentIds,
    });
    return {
      result: {
        rawTextBlobId: artifact.rawTextObjectRef.blobId,
        parserVersion: parsed.parserVersion,
        contentHash: parsed.contentHash,
        diagnostics: processed.diagnostics,
        childJobIds: indexJobIds,
        segmentIds,
      },
      value: segmentIds,
      waitingForChildren: true,
    };
  }

  private async processIndex(job: S6JobRecord, context: TenantContext) {
    const segmentId = job.resourceId;
    const segment = await this.input.store.getSegment(segmentId, context);
    if (!segment) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { segmentId });
    const operation = String(job.inputSnapshot.operation ?? 'index');
    if (operation === 'delete') {
      const index = job.inputSnapshot.index as
        | { indexId?: string; dimension?: number; modelId?: string }
        | undefined;
      if (index?.indexId && index.dimension && index.modelId) {
        await this.input.vectors.deleteBySegment(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: segment.knowledgeSpaceId,
            segmentId,
            dimension: index.dimension,
            embeddingModelId: index.modelId,
            indexId: index.indexId,
          },
          context,
        );
      }
      const updated = await this.input.store.removeSegmentIndex(
        segment.id,
        segment.version,
        index?.indexId,
        context,
      );
      if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { segmentId });
      await this.refreshSourceIndexStatus(segment.sourceId, context);
      return { result: { deletedIndexId: index?.indexId ?? null }, value: segmentId };
    }
    const supplied = job.inputSnapshot.index as
      | { indexId: string; type: string; modelId: string; text: string }
      | undefined;
    const existing =
      segment.indexes.find((candidate) => candidate.indexId === (supplied?.indexId ?? 'default')) ??
      segment.indexes[0];
    const bindings = await this.input.bindings.list(String(segment.knowledgeSpaceId), context);
    const requestedModelId = String(
      job.inputSnapshot.modelId ??
        supplied?.modelId ??
        existing?.modelId ??
        bindings.find((binding) => binding.modelType === 'embedding' && binding.status === 'active')
          ?.modelId ??
        '',
    );
    const catalog = await this.input.models.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const model = catalog.find(
      (candidate) =>
        candidate.modelId === requestedModelId &&
        candidate.type === 'embedding' &&
        candidate.authorized &&
        candidate.dimension !== null,
    );
    if (!model || model.dimension === null) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'embeddingModelId', reason: 'binding_required' },
      });
    }
    const indexId = supplied?.indexId ?? existing?.indexId ?? 'default';
    const text = supplied?.text ?? existing?.text ?? segment.content;
    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const indexVersion = segment.version + 2;
    const vectors = await this.input.port.embed(
      {
        modelId: model.modelId,
        dimension: model.dimension,
        texts: [text],
        knowledgeSpaceId: segment.knowledgeSpaceId,
        sourceId: segment.sourceId,
      },
      context,
    );
    const vector = vectors[0];
    if (!vector)
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        retryable: true,
        details: { reason: 'embedding_empty' },
      });
    const written = await this.input.vectors.insert(
      [
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: segment.knowledgeSpaceId,
          sourceId: segment.sourceId,
          segmentId,
          indexId,
          embeddingModelId: model.modelId,
          dimension: model.dimension,
          vector,
          searchEnabled: segment.searchEnabled,
          contentHash,
          version: indexVersion,
        },
      ],
      context,
    );
    await this.input.jobs.setStep(
      {
        jobId: String(job._id),
        stepKey: 'write-vectors',
        status: 'succeeded',
        idempotencyKey: `vectors:${segmentId}:${indexId}:${indexVersion}`,
        evidence: {
          vectorId: written.vectorIds[0],
          dimension: model.dimension,
          contentHash,
          indexVersion,
        },
      },
      context,
    );
    const projected = await this.input.fulltext.project(
      {
        segmentId,
        sourceVersion: segment.sourceVersion,
        indexVersion,
        question: segment.question,
        answer: segment.answer,
        content: segment.content,
        ...(typeof segment.metadata.title === 'string' ? { title: segment.metadata.title } : {}),
        searchEnabled: segment.searchEnabled,
        expectedVersion: segment.version,
      },
      context,
    );
    const profile = this.input.vectors
      .listProfiles()
      .find((item) => item.dimension === model.dimension);
    if (!profile) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'vector_profile_missing', dimension: model.dimension },
      });
    }
    const nextIndex = {
      indexId,
      type: supplied?.type ?? existing?.type ?? 'default',
      modelId: model.modelId,
      dimension: model.dimension,
      storageType: profile.storageType,
      vectorProfile: profile.tableName,
      vectorId: written.vectorIds[0]!,
      text,
      version: indexVersion,
    };
    const indexes = [
      ...segment.indexes.filter((candidate) => candidate.indexId !== indexId),
      nextIndex,
    ];
    const synonymVersion =
      (await this.input.synonymVersion?.getPublishedFileVersion(
        segment.knowledgeSpaceId,
        context,
      )) ?? segment.synonymVersion;
    const switched = await this.input.store.switchSegmentIndex(
      {
        segmentId,
        expectedVersion: projected.segmentVersion,
        fullTextVersion: indexVersion,
        indexes,
        synonymVersion,
      },
      context,
    );
    if (!switched) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { segmentId, indexId });
    await this.input.jobs.setStep(
      {
        jobId: String(job._id),
        stepKey: 'switch-index',
        status: 'succeeded',
        idempotencyKey: `switch:${segmentId}:${indexId}:${indexVersion}`,
        evidence: {
          vectorId: written.vectorIds[0],
          indexVersion,
          fullTextVersion: projected.fullTextVersion,
        },
      },
      context,
    );
    await this.refreshSourceIndexStatus(segment.sourceId, context);
    return {
      result: {
        vectorIds: written.vectorIds,
        indexVersion,
        fullTextVersion: projected.fullTextVersion,
        profile,
      },
      value: indexId,
    };
  }

  private async processRebuild(job: S6JobRecord, context: TenantContext) {
    const rootJobId = String(job.inputSnapshot.rootJobId ?? job._id);
    if (job.resourceType === 'space') {
      const sourceIds = Array.isArray(job.inputSnapshot.sourceIds)
        ? [...new Set(job.inputSnapshot.sourceIds.map(String))]
        : [];
      if (sourceIds.length === 0) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'inputSnapshot.sourceIds', min: 1 },
        });
      }
      const childJobIds: string[] = [];
      for (const sourceId of sourceIds) {
        const source = await this.input.store.getSource(sourceId, context);
        if (!source || source.knowledgeSpaceId !== String(job.knowledgeSpaceId)) {
          throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId });
        }
        const child = await this.input.jobs.createChild(
          {
            kind: 'rebuild',
            resourceType: 'source',
            resourceId: sourceId,
            knowledgeSpaceId: source.knowledgeSpaceId,
            inputSnapshot: {
              sourceId,
              sourceVersion: source.sourceVersion,
              reason: job.inputSnapshot.reason,
              ...(job.inputSnapshot.targetModelId
                ? { targetModelId: job.inputSnapshot.targetModelId }
                : {}),
              expectedSegmentVersions: [],
              rootJobId,
              parentJobId: String(job._id),
            },
            rootJobId,
            parentJobId: String(job._id),
            priority: job.priority,
            idempotencyKey: `${job._id}:${sourceId}:${source.sourceVersion}:rebuild`,
          },
          context,
        );
        childJobIds.push(child.jobId);
      }
      await this.input.store.updateSourcesStatus(sourceIds, 'rebuilding', context);
      await this.input.jobs.releaseWaitingForChildren(String(job._id), childJobIds, context, {
        sourceIds,
      });
      return {
        result: { childJobIds, sourceIds },
        value: childJobIds,
        waitingForChildren: true,
      };
    }
    const sourceId = String(job.inputSnapshot.sourceId ?? job.resourceId);
    const source = await this.input.store.getSource(sourceId, context);
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId });
    const segments = await this.input.store.listSegmentsBySource(sourceId, context);
    if (segments.length === 0) {
      await this.input.store.updateSourceStatus(sourceId, 'ready', context, source.sourceVersion);
      return { result: { childJobIds: [], rebuildVersion: source.sourceVersion }, value: [] };
    }
    const childJobIds: string[] = [];
    for (const segment of segments) {
      const child = await this.input.jobs.createChild(
        {
          kind: 'index',
          resourceType: 'segment',
          resourceId: segment.id,
          knowledgeSpaceId: source.knowledgeSpaceId,
          inputSnapshot: {
            operation: 'reindex',
            reason: job.inputSnapshot.reason,
            modelId: job.inputSnapshot.targetModelId ?? null,
            sourceVersion: source.sourceVersion,
            expectedVersion: segment.version,
            rootJobId,
            parentJobId: String(job._id),
          },
          rootJobId,
          parentJobId: String(job._id),
          priority: job.priority,
          idempotencyKey: `${job._id}:${segment.id}:${segment.version}:reindex`,
        },
        context,
      );
      childJobIds.push(child.jobId);
    }
    await this.input.store.updateSourceStatus(sourceId, 'rebuilding', context);
    await this.input.jobs.releaseWaitingForChildren(String(job._id), childJobIds, context, {
      rebuildVersion: source.sourceVersion,
    });
    return {
      result: { childJobIds, rebuildVersion: source.sourceVersion },
      value: childJobIds,
      waitingForChildren: true,
    };
  }

  private async processQa(job: S6JobRecord, context: TenantContext) {
    const segment = await this.input.store.getSegment(job.resourceId, context);
    if (!segment) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { segmentId: job.resourceId });
    const source = await this.input.store.getSource(segment.sourceId, context);
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId: segment.sourceId });
    const settings = {
      trainingType: 'qa' as const,
      chunkSettingMode: 'custom' as const,
      chunkSize: Math.max(64, Math.min(segment.content.length, 8000)),
      overlap: 0,
    };
    const generated = await this.input.processing.generateQaForChunks({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: segment.knowledgeSpaceId,
      sourceId: segment.sourceId,
      settings,
      chunks: [
        {
          index: segment.order,
          text: segment.content,
          contentHash: `sha256:${createHash('sha256').update(segment.content).digest('hex')}`,
        },
      ],
      context,
    });
    if (generated.items.length === 0) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        retryable: true,
        details: { reason: 'qa_empty' },
      });
    }
    const updated = await this.input.store.updateSegmentQa(
      segment.id,
      segment.version,
      {
        question: generated.items[0]!.q,
        answer: generated.items[0]!.a,
        content: `${generated.items[0]!.q}\n${generated.items[0]!.a}`.trim(),
      },
      context,
    );
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { segmentId: job.resourceId });
    return {
      result: {
        qaSegmentIds: [segment.id],
        fallbackUsed: generated.fallbackUsed,
        promptVersion: generated.promptVersion,
      },
      value: segment.id,
    };
  }

  private async processSync(job: S6JobRecord, context: TenantContext) {
    let discovered:
      | {
          sourceIds: string[];
          sourceVersions: Record<string, number>;
          cursorVersion: number;
          sourceCount: number;
          changeSetHash: string;
          replayed: boolean;
        }
      | undefined;
    let sourceIds: string[];
    if (Array.isArray(job.inputSnapshot.sourceIds)) {
      sourceIds = [...new Set(job.inputSnapshot.sourceIds.map(String))];
    } else {
      const connectorId = String(job.inputSnapshot.connectorId ?? '');
      if (!connectorId || !this.input.sync) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CURSOR_INVALID',
          requestId: context.requestId,
          traceId: context.traceId,
          retryable: false,
          details: { reason: 'change_set_required', connectorId },
        });
      }
      discovered = await this.input.sync.discover(
        {
          jobId: String(job._id),
          connectorId,
          full: job.inputSnapshot.full === true,
        },
        context,
      );
      sourceIds = discovered.sourceIds;
    }
    if (sourceIds.length === 0) {
      await this.input.jobs.setStep(
        {
          jobId: String(job._id),
          stepKey: 'sync-batch',
          status: 'succeeded',
          idempotencyKey: `sync-batch:${job._id}:empty`,
          evidence: {
            sourceCount: 0,
            cursorVersion: discovered?.cursorVersion ?? job.inputSnapshot.cursorVersion ?? null,
            changeSetHash: discovered?.changeSetHash ?? null,
            replayed: discovered?.replayed ?? false,
          },
        },
        context,
      );
      return {
        result: {
          childJobIds: [],
          cursorVersion: discovered?.cursorVersion ?? job.inputSnapshot.cursorVersion ?? null,
          sourceCount: 0,
          changeSetHash: discovered?.changeSetHash ?? null,
          replayed: discovered?.replayed ?? false,
        },
        value: [],
      };
    }
    const childJobIds: string[] = [];
    for (const sourceId of sourceIds) {
      const source = await this.input.store.getSource(sourceId, context);
      if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId });
      const child = await this.input.jobs.createChild(
        {
          kind: 'parse',
          resourceType: 'source',
          resourceId: sourceId,
          knowledgeSpaceId: source.knowledgeSpaceId,
          inputSnapshot: {
            sourceId,
            sourceVersion: source.sourceVersion,
            parseProvider: source.parseProvider,
            configHash: String(job.inputSnapshot.configurationHash ?? ''),
            chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
            rootJobId: String(job.inputSnapshot.rootJobId ?? job._id),
            parentJobId: String(job._id),
          },
          rootJobId: String(job.inputSnapshot.rootJobId ?? job._id),
          parentJobId: String(job._id),
          priority: job.priority,
          idempotencyKey: `${job._id}:${sourceId}:${source.sourceVersion}:sync-parse`,
        },
        context,
      );
      childJobIds.push(child.jobId);
    }
    await this.input.store.updateSourcesStatus(sourceIds, 'parsing', context);
    await this.input.jobs.setStep(
      {
        jobId: String(job._id),
        stepKey: 'sync-batch',
        status: 'succeeded',
        idempotencyKey: `sync-batch:${job._id}:${sourceIds.join(',')}`,
        evidence: {
          sourceCount: sourceIds.length,
          sourceVersions: discovered?.sourceVersions ?? job.inputSnapshot.sourceVersions ?? {},
          cursorVersion: discovered?.cursorVersion ?? job.inputSnapshot.cursorVersion ?? null,
          changeSetHash: discovered?.changeSetHash ?? null,
          replayed: discovered?.replayed ?? false,
        },
      },
      context,
    );
    await this.input.jobs.releaseWaitingForChildren(String(job._id), childJobIds, context, {
      cursorVersion: discovered?.cursorVersion ?? job.inputSnapshot.cursorVersion ?? null,
      changeSetHash: discovered?.changeSetHash ?? null,
    });
    return {
      result: {
        childJobIds,
        cursorVersion: discovered?.cursorVersion ?? job.inputSnapshot.cursorVersion ?? null,
        changeSetHash: discovered?.changeSetHash ?? null,
      },
      value: childJobIds,
      waitingForChildren: true,
    };
  }

  async handleQueue(
    queue: QueueName,
    jobId: string,
    workerId: string,
    context: TenantContext,
  ): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    if (queue === 'knowledge-rebuild') {
      const raw = await this.input.jobs.getRaw(jobId, context);
      if (raw.kind === 'synonym_rebuild') {
        if (!this.input.synonymRebuild) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: false,
            details: { queue, reason: 's09_rebuild_executor_missing' },
          });
        }
        return this.input.synonymRebuild.handleQueue(jobId, workerId, context);
      }
    }
    return this.withJob<unknown>(queue, jobId, workerId, context, async (job) => {
      if (queue === 'knowledge-caption') {
        if (!this.input.caption) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { queue, reason: 'caption_executor_missing' },
          });
        }
        return this.input.caption.execute(job, context);
      }
      if (queue === 'knowledge-parse') return this.processParse(job, context);
      if (queue === 'knowledge-segment' || queue === 'knowledge-ocr') {
        return this.processParse(job, context);
      }
      if (queue === 'knowledge-qa') return this.processQa(job, context);
      if (queue === 'knowledge-embed' || queue === 'knowledge-index') {
        return this.processIndex(job, context);
      }
      if (queue === 'knowledge-rebuild') return this.processRebuild(job, context);
      if (queue === 'knowledge-sync') return this.processSync(job, context);
      if (queue === 'knowledge-delete') {
        const deletedSegments =
          job.resourceType === 'segment'
            ? [await this.input.store.getSegment(job.resourceId, context)].filter(
                (segment): segment is S6SegmentRecord => segment !== null,
              )
            : await this.input.store.listSegmentsBySource(job.resourceId, context);
        for (const segment of deletedSegments) {
          for (const index of segment.indexes) {
            await this.input.vectors.deleteBySegment(
              {
                workspaceId: context.workspaceId,
                knowledgeSpaceId: segment.knowledgeSpaceId,
                segmentId: segment.id,
                dimension: index.dimension,
                embeddingModelId: index.modelId,
                indexId: index.indexId,
              },
              context,
            );
          }
        }
        await this.input.store.softDeleteSegments(
          {
            resourceType: job.resourceType === 'segment' ? 'segment' : 'source',
            resourceId: job.resourceId,
          },
          context,
        );
        return { result: { deleted: true }, value: undefined };
      }
      if (queue === 'knowledge-cleanup') {
        const activeSegments = await this.input.store.listActiveWorkspaceSegments(context);
        const activeVectorIds = [
          ...new Set(
            activeSegments.flatMap((segment) =>
              segment.indexes.map((index) => index.vectorId).filter(Boolean),
            ),
          ),
        ];
        const retentionDays = Number(job.inputSnapshot.retentionDays ?? 30);
        const result = await this.input.vectors.cleanupUnreferenced(
          {
            workspaceId: context.workspaceId,
            activeVectorIds,
            olderThan: new Date(Date.now() - Math.max(30, retentionDays) * 86_400_000),
            batchSize: Number(job.inputSnapshot.batchSize ?? 500),
          },
          context,
        );
        await this.input.jobs.setStep(
          {
            jobId: String(job._id),
            stepKey: 'cleanup-old-versions',
            status: 'succeeded',
            idempotencyKey: `cleanup:${job._id}:${context.workspaceId}`,
            evidence: result,
          },
          context,
        );
        return { result, value: result.deleted };
      }
      if (queue === 'knowledge-outbox') {
        const dispatched = await this.input.port.dispatchOutbox(context);
        return { result: { dispatched }, value: dispatched };
      }
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        retryable: false,
        details: { queue, reason: 'executor_not_available_in_this_phase' },
      });
    }).then((result) => result.outcome);
  }
}
