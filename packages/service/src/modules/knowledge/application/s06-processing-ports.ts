import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  KnowledgeSegmentDoc,
  SegmentIndexValue,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeJobDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type { S5ArtifactMaterializeResult, S5ParseResult } from './s5-processing-ports';

export type S6JobRecord = KnowledgeJobDoc & {
  _id: { toString(): string };
};

export type S6ChildJobKind =
  | 'parse'
  | 'segment'
  | 'qa'
  | 'caption'
  | 'embed'
  | 'index'
  | 'fulltext'
  | 'rebuild';

export interface S6SourceRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: string;
  sourceVersion: number;
  blobRefId: string | null;
  name: string;
  mimeType: string;
  parseProvider: string;
  searchEnabled: boolean;
  processingStatus: string;
  version: number;
}

export interface S6SegmentRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion: number;
  searchEnabled: boolean;
  order: number;
  question: string;
  answer: string;
  content: string;
  fullTextTokens: string;
  fullTextVersion: number;
  metadata: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  indexes: SegmentIndexValue[];
  indexStatus: KnowledgeSegmentDoc['indexStatus'];
  indexErrorCode: string | null;
  imageBlobRefId?: string | null;
  imageDescription?: string | null;
  version: number;
}

export interface S6JobPort {
  getRaw(jobId: string, context: TenantContext): Promise<S6JobRecord>;
  hydrateOutbox(
    outboxEventId: string,
    context: TenantContext,
  ): Promise<{
    eventType: string;
    eventKey: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    workspaceId: string;
  }>;
  claimById(
    input: { jobId: string; kinds: readonly KnowledgeJobDoc['kind'][]; workerId: string },
    context: TenantContext,
  ): Promise<{ version: number; attemptEpoch: number } | null>;
  start(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    context: TenantContext,
  ): Promise<{ version: number; attemptEpoch: number }>;
  heartbeat(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    context: TenantContext,
  ): Promise<{ version: number; attemptEpoch: number }>;
  commit(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    result: Record<string, unknown>,
    context: TenantContext,
  ): Promise<{ status: string }>;
  fail(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    retryable: boolean,
    errorCode: string,
    context: TenantContext,
  ): Promise<{ status: string }>;
  setStep(
    input: {
      jobId: string;
      stepKey: string;
      status:
        | 'pending'
        | 'running'
        | 'succeeded'
        | 'retry_wait'
        | 'failed'
        | 'compensated'
        | 'skipped';
      idempotencyKey: string;
      evidence?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
      compensationState?: 'none' | 'required' | 'running' | 'succeeded' | 'failed';
    },
    context: TenantContext,
  ): Promise<unknown>;
  createChild(
    input: {
      kind: S6ChildJobKind;
      resourceType: 'space' | 'source' | 'segment';
      resourceId: string;
      knowledgeSpaceId: string;
      inputSnapshot: Record<string, unknown>;
      rootJobId: string;
      parentJobId: string;
      priority: number;
      idempotencyKey: string;
    },
    context: TenantContext,
  ): Promise<{ jobId: string }>;
  releaseWaitingForChildren(
    jobId: string,
    childJobIds: string[],
    context: TenantContext,
    resultPatch?: Record<string, unknown>,
  ): Promise<unknown>;
  aggregateRoot(jobId: string, context: TenantContext): Promise<{ status: string } | null>;
  recoverExpiredLeases(context: TenantContext): Promise<number>;
  requeueDueRetries(context: TenantContext): Promise<number>;
}

export interface S6ArtifactPort {
  materialize(
    input: {
      sourceId: string;
      sourceVersion: number;
      knowledgeSpaceId: string;
      parse: S5ParseResult;
    },
    context: TenantContext,
  ): Promise<S5ArtifactMaterializeResult>;
}

export interface S6VectorPort {
  insert(
    records: readonly {
      workspaceId: string;
      knowledgeSpaceId: string;
      sourceId: string;
      segmentId: string;
      indexId: string;
      embeddingModelId: string;
      dimension: number;
      vector: readonly number[];
      searchEnabled: boolean;
      contentHash: string;
      version: number;
    }[],
    context: TenantContext,
  ): Promise<{ inserted: number; vectorIds: string[] }>;
  deleteBySegment(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      segmentId: string;
      dimension: number;
      embeddingModelId: string;
      indexId?: string;
    },
    context: TenantContext,
  ): Promise<{ deleted: number }>;
  listProfiles(): ReadonlyArray<{
    tableName: string;
    storageType: 'vector' | 'halfvec';
    dimension: number;
  }>;
  cleanupUnreferenced(
    input: {
      workspaceId: string;
      activeVectorIds: readonly string[];
      olderThan: Date;
      batchSize?: number;
    },
    context: TenantContext,
  ): Promise<{ deleted: number; byProfile: Record<string, number> }>;
}

export interface S6FullTextPort {
  project(
    input: {
      segmentId: string;
      sourceVersion: number;
      indexVersion: number;
      question: string;
      answer: string;
      content: string;
      title?: string;
      searchEnabled: boolean;
      expectedVersion: number;
    },
    context: TenantContext,
  ): Promise<{
    fullTextVersion: number;
    segmentVersion: number;
    tokenizerVersion: string;
    tokensHash: string;
  }>;
}

export interface S6ProcessingStorePort {
  getSource(sourceId: string, context: TenantContext): Promise<S6SourceRecord | null>;
  getSegment(segmentId: string, context: TenantContext): Promise<S6SegmentRecord | null>;
  listSegmentsBySource(sourceId: string, context: TenantContext): Promise<S6SegmentRecord[]>;
  listActiveWorkspaceSegments(context: TenantContext): Promise<S6SegmentRecord[]>;
  updateSourcesStatus(
    sourceIds: readonly string[],
    status: KnowledgeSourceStatus,
    context: TenantContext,
  ): Promise<void>;
  updateSourceStatus(
    sourceId: string,
    status: KnowledgeSourceStatus,
    context: TenantContext,
    sourceVersion?: number,
  ): Promise<void>;
  upsertParsedSegments(
    input: {
      source: S6SourceRecord;
      sourceVersion: number;
      rows: ReadonlyArray<{ order: number; question: string; answer: string; content: string }>;
    },
    context: TenantContext,
  ): Promise<string[]>;
  softDeleteSegmentsAfterOrder(
    sourceId: string,
    order: number,
    context: TenantContext,
  ): Promise<void>;
  markIndexFailure(segmentId: string, errorCode: string, context: TenantContext): Promise<void>;
  removeSegmentIndex(
    segmentId: string,
    expectedVersion: number,
    indexId: string | undefined,
    context: TenantContext,
  ): Promise<S6SegmentRecord | null>;
  switchSegmentIndex(
    input: {
      segmentId: string;
      expectedVersion: number;
      fullTextVersion: number;
      indexes: SegmentIndexValue[];
    },
    context: TenantContext,
  ): Promise<S6SegmentRecord | null>;
  updateSegmentQa(
    segmentId: string,
    expectedVersion: number,
    qa: { question: string; answer: string; content: string },
    context: TenantContext,
  ): Promise<S6SegmentRecord | null>;
  softDeleteSegments(
    filter: { resourceType: 'source' | 'segment'; resourceId: string },
    context: TenantContext,
  ): Promise<number>;
}

export type KnowledgeSourceStatus =
  | 'queued'
  | 'parsing'
  | 'indexing'
  | 'rebuilding'
  | 'ready'
  | 'partial'
  | 'failed';

export interface S6ExternalProcessingPort {
  parse(
    input: {
      sourceId: string;
      blobRefId: string;
      knowledgeSpaceId: string;
      sourceVersion: number;
      fileName: string;
      mimeType: string;
      parseProvider: string;
    },
    context: TenantContext,
  ): Promise<S5ParseResult>;
  embed(
    input: {
      modelId: string;
      dimension: 768 | 1024 | 1536 | 3072;
      texts: string[];
      knowledgeSpaceId: string;
      sourceId: string;
    },
    context: TenantContext,
  ): Promise<number[][]>;
  dispatchOutbox(context: TenantContext): Promise<boolean>;
}

export interface S6ConnectorSyncResult {
  sourceIds: string[];
  sourceVersions: Record<string, number>;
  cursorVersion: number;
  sourceCount: number;
  changeSetHash: string;
  replayed: boolean;
}

export interface S6ConnectorSyncPort {
  discover(
    input: {
      jobId: string;
      connectorId: string;
      full: boolean;
    },
    context: TenantContext,
  ): Promise<S6ConnectorSyncResult>;
  complete(
    input: {
      connectorId: string;
      success: boolean;
      errorCode?: string;
    },
    context: TenantContext,
  ): Promise<void>;
}
