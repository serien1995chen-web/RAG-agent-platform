export type SynonymRebuildReason = 'synonym_change' | 'model_change' | 'source_rebuild' | 'manual';

export interface SynonymRebuildPlan {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  reason: SynonymRebuildReason;
  candidateFileVersion: number;
  expectedActiveFileVersion: number;
  oldPublishedFileVersion: number | null;
  sourceIds: string[];
  indexedSegmentVersions: Record<string, number>;
  oldQueryModelId: string | null;
  oldQueryDimension: 768 | 1024 | 1536 | 3072 | null;
  targetModelId: string;
  targetDimension: 768 | 1024 | 1536 | 3072;
  idempotencyKey: string;
  startedAt: Date;
  lease?: {
    workerId: string;
    fencingToken: string;
    attemptEpoch: number;
    jobVersion: number;
  };
}

export interface SynonymStagedRebuild {
  stagingId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  candidateFileVersion: number;
  sourceIds: string[];
  indexedSegmentVersions: Record<string, number>;
  reusedVectorCount: number;
  rebuiltCount: number;
  segments?: Array<{
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
  }>;
  cleanupCandidates: Array<{
    vectorId: string;
    dimension: 768 | 1024 | 1536 | 3072;
    availableAt: Date;
  }>;
  failureEvidence: Record<string, unknown> | null;
}

export interface SynonymRebuildResult {
  sourceIds: string[];
  indexedSegmentVersions: Record<string, number>;
  oldVersions: {
    publishedFileVersion: number | null;
    queryModelId: string | null;
    queryDimension: 768 | 1024 | 1536 | 3072 | null;
  };
  newVersions: {
    publishedFileVersion: number;
    queryModelId: string;
    queryDimension: 768 | 1024 | 1536 | 3072;
  };
  failureEvidence: Record<string, unknown> | null;
  cleanupCandidates: Array<{
    vectorId: string;
    dimension: 768 | 1024 | 1536 | 3072;
    availableAt: string;
  }>;
  rebuiltCount: number;
  reusedVectorCount: number;
}

export function rebuildIdempotencyKey(input: {
  knowledgeSpaceId: string;
  fileVersion: number;
  reason: SynonymRebuildReason;
}): string {
  return `synonym_rebuild:${input.knowledgeSpaceId}:${input.fileVersion}:${input.reason}`;
}

export function buildRebuildPlan(
  input: Omit<SynonymRebuildPlan, 'idempotencyKey' | 'startedAt'> &
    Partial<Pick<SynonymRebuildPlan, 'idempotencyKey' | 'startedAt'>>,
): SynonymRebuildPlan {
  const sourceIds = [...new Set(input.sourceIds)];
  if (sourceIds.length !== input.sourceIds.length) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 's09-rebuild-plan',
      traceId: 's09-rebuild-plan',
      details: { field: 'sourceIds', reason: 'unique' },
    });
  }
  if (!Number.isInteger(input.candidateFileVersion) || input.candidateFileVersion < 1) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 's09-rebuild-plan',
      traceId: 's09-rebuild-plan',
      details: { field: 'candidateFileVersion', min: 1 },
    });
  }
  if (!Number.isInteger(input.expectedActiveFileVersion) || input.expectedActiveFileVersion < 1) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 's09-rebuild-plan',
      traceId: 's09-rebuild-plan',
      details: { field: 'expectedActiveFileVersion', min: 1 },
    });
  }
  if (![768, 1024, 1536, 3072].includes(input.targetDimension)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 's09-rebuild-plan',
      traceId: 's09-rebuild-plan',
      details: { field: 'targetDimension', allowed: [768, 1024, 1536, 3072] },
    });
  }
  return {
    ...input,
    sourceIds,
    idempotencyKey:
      input.idempotencyKey ??
      rebuildIdempotencyKey({
        knowledgeSpaceId: input.knowledgeSpaceId,
        fileVersion: input.candidateFileVersion,
        reason: input.reason,
      }),
    startedAt: input.startedAt ?? new Date(),
  };
}

export function rebuildResult(
  plan: SynonymRebuildPlan,
  staged: SynonymStagedRebuild,
): SynonymRebuildResult {
  return {
    sourceIds: [...staged.sourceIds].sort(),
    indexedSegmentVersions: { ...staged.indexedSegmentVersions },
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
    failureEvidence: staged.failureEvidence,
    cleanupCandidates: staged.cleanupCandidates
      .map((candidate) => ({
        ...candidate,
        availableAt: candidate.availableAt.toISOString(),
      }))
      .sort(
        (left, right) =>
          left.dimension - right.dimension || left.vectorId.localeCompare(right.vectorId),
      ),
    rebuiltCount: staged.rebuiltCount,
    reusedVectorCount: staged.reusedVectorCount,
  };
}

export function cleanupAvailableAt(switchedAt: Date): Date {
  return new Date(switchedAt.getTime() + 30 * 86_400_000);
}

export function isCleanupCandidateReady(availableAt: Date, now: Date): boolean {
  return availableAt.getTime() <= now.getTime();
}
import { createKnowledgeError } from '@kb/contracts';
