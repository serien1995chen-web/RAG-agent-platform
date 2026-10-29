import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { S6JobRecord } from '../../src/modules/knowledge/application/s06-processing-ports';
import {
  S09RebuildApplication,
  S09RebuildQueueHandler,
} from '../../src/modules/knowledge/application/s09-rebuild.application';
import {
  buildRebuildPlan,
  cleanupAvailableAt,
  isCleanupCandidateReady,
  type SynonymRebuildPlan,
  type SynonymStagedRebuild,
} from '../../src/modules/knowledge/domain/s09-synonym-rebuild';
import { S09SynonymS6Adapter } from '../../src/modules/knowledge/adapter/s09-synonym-s6.adapter';

const context: TenantContext = {
  workspaceId: 'ws_s9_rebuild',
  memberId: 'system:knowledge-worker',
  requestId: 'req_s9_rebuild',
  traceId: 'trace_s9_rebuild'.padEnd(32, '0'),
  scopes: ['knowledge:admin'],
};
const jobId = '65f1e5b2a1c9d4b7e8f09999';
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f01111';

function plan(): SynonymRebuildPlan {
  return buildRebuildPlan({
    jobId,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: spaceId,
    reason: 'synonym_change',
    candidateFileVersion: 2,
    expectedActiveFileVersion: 1,
    oldPublishedFileVersion: 1,
    sourceIds: [sourceId],
    indexedSegmentVersions: {
      '65f1e5b2a1c9d4b7e8f02222': 3,
    },
    oldQueryModelId: 'embedding-768',
    oldQueryDimension: 768,
    targetModelId: 'embedding-1024',
    targetDimension: 1024,
  });
}

function staged(value: SynonymRebuildPlan): SynonymStagedRebuild {
  return {
    stagingId: 'staging-1',
    workspaceId: context.workspaceId,
    knowledgeSpaceId: spaceId,
    candidateFileVersion: value.candidateFileVersion,
    sourceIds: [sourceId],
    indexedSegmentVersions: {
      '65f1e5b2a1c9d4b7e8f02222': 4,
    },
    reusedVectorCount: 2,
    rebuiltCount: 1,
    cleanupCandidates: [
      {
        vectorId: 'old-vector',
        dimension: 768,
        availableAt: cleanupAvailableAt(new Date('2026-10-01T00:00:00.000Z')),
      },
    ],
    failureEvidence: null,
  };
}

function jobRaw(status: string = 'queued'): S6JobRecord {
  return {
    _id: jobId,
    kind: 'synonym_rebuild',
    status,
    fencingToken: 'fencing-1',
  } as unknown as S6JobRecord;
}

function fixture(
  s6Overrides: {
    stage?: () => Promise<SynonymStagedRebuild>;
    finalizeInSession?: () => Promise<SynonymStagedRebuild>;
  } = {},
) {
  let status = 'queued';
  const getRaw = vi.fn(async () => {
    const value = jobRaw(status);
    status = status === 'queued' ? 'leased' : status;
    return value;
  });
  const claimById = vi.fn(async () => ({ version: 2, attemptEpoch: 1 }));
  const start = vi.fn(async () => {
    status = 'running';
    return { version: 3, attemptEpoch: 1 };
  });
  const setStep = vi.fn(async () => undefined);
  const completeRebuild = vi.fn(
    async (
      _plan: SynonymRebuildPlan,
      _staged: SynonymStagedRebuild,
      _result: unknown,
      _context: TenantContext,
      finalize?: (session: unknown) => Promise<void>,
    ) => {
      if (finalize) await finalize('session');
    },
  );
  const failRebuild = vi.fn(async () => undefined);
  const stageProfile = vi.fn(
    s6Overrides.stage ?? (async (value: SynonymRebuildPlan) => staged(value)),
  );
  const reuseOrBuildVector = vi.fn(async (_value, value) => value);
  const finalizeInSession = vi.fn(
    s6Overrides.finalizeInSession ?? (async (value: SynonymRebuildPlan) => staged(value)),
  );
  const finalize = vi.fn(async (value: SynonymRebuildPlan) => staged(value));
  const rollback = vi.fn(async () => undefined);
  const application = new S09RebuildApplication({
    repository: {
      async getRebuildPlan() {
        return plan();
      },
      completeRebuild,
      failRebuild,
    },
    s6: {
      stageProfile,
      reuseOrBuildVector,
      finalize,
      finalizeInSession,
      rollback,
    },
    jobs: { getRaw, claimById, start, setStep },
  });
  return {
    application,
    completeRebuild,
    failRebuild,
    stageProfile,
    reuseOrBuildVector,
    finalizeInSession,
    finalize,
    rollback,
    setStep,
  };
}

describe('S9 synonym rebuild application', () => {
  it('TEST-TRAIN-006-BLOCK stages, finalizes and commits one complete result', async () => {
    const state = fixture();
    await expect(state.application.handleQueue(jobId, 'worker-1', context)).resolves.toBe(
      'succeeded',
    );
    expect(state.stageProfile).toHaveBeenCalledWith(expect.objectContaining({ jobId }), context);
    expect(state.reuseOrBuildVector).toHaveBeenCalledTimes(1);
    expect(state.finalizeInSession).toHaveBeenCalledWith(
      expect.objectContaining({ jobId }),
      expect.objectContaining({ stagingId: 'staging-1' }),
      context,
      'session',
    );
    expect(state.failRebuild).not.toHaveBeenCalled();
    expect(state.completeRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ jobId }),
      expect.objectContaining({ stagingId: 'staging-1' }),
      expect.objectContaining({
        sourceIds: [sourceId],
        indexedSegmentVersions: {
          '65f1e5b2a1c9d4b7e8f02222': 4,
        },
        newVersions: {
          publishedFileVersion: 2,
          queryModelId: 'embedding-1024',
          queryDimension: 1024,
        },
      }),
      context,
      expect.any(Function),
    );
  });

  it('TEST-TRAIN-006-BLOCK keeps old state on staging failure and returns retry evidence', async () => {
    const state = fixture({
      stage: async () => {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: context.requestId,
          traceId: context.traceId,
          retryable: true,
          details: { dependency: 'pgvector' },
        });
      },
    });
    await expect(state.application.handleQueue(jobId, 'worker-1', context)).resolves.toBe('retry');
    expect(state.rollback).not.toHaveBeenCalled();
    expect(state.completeRebuild).not.toHaveBeenCalled();
    expect(state.failRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ jobId }),
      expect.objectContaining({
        retryable: true,
        errorCode: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        failureEvidence: expect.objectContaining({ stage: 'stage' }),
      }),
      context,
    );
  });

  it('TEST-X-PGVECTOR-PARTIAL rolls back staged vectors after finalize failure', async () => {
    const state = fixture({
      finalizeInSession: async () => {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          retryable: false,
          details: { reason: 'partial_vector_failure' },
        });
      },
    });
    await expect(state.application.handleQueue(jobId, 'worker-1', context)).resolves.toBe(
      'dead_letter',
    );
    expect(state.rollback).toHaveBeenCalledWith('staging-1', context);
    expect(state.completeRebuild).toHaveBeenCalledTimes(1);
    expect(state.failRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ oldPublishedFileVersion: 1 }),
      expect.objectContaining({
        retryable: false,
        failureEvidence: expect.objectContaining({ stage: 'finalize' }),
      }),
      context,
    );
  });

  it('TEST-TRAIN-006-BLOCK exposes the knowledge-rebuild queue handler contract', async () => {
    const state = fixture();
    const handler = new S09RebuildQueueHandler(state.application);
    await expect(handler.handle({ jobId }, 'worker-1', context)).resolves.toBe('succeeded');
  });

  it('TEST-TRAIN-006-BLOCK delegates S6 staging and cleanup only through its Port', async () => {
    const value = plan();
    const stagedValue = staged(value);
    const index = {
      stage: vi.fn(async () => stagedValue),
      reuseOrBuildVector: vi.fn(async () => stagedValue),
      finalize: vi.fn(async () => ({
        indexedSegmentVersions: stagedValue.indexedSegmentVersions,
        cleanupCandidates: stagedValue.cleanupCandidates,
      })),
      rollback: vi.fn(async () => undefined),
    };
    const adapter = new S09SynonymS6Adapter(index);
    await adapter.stageProfile(value, context);
    await adapter.reuseOrBuildVector(value, stagedValue, context);
    await adapter.finalize(value, stagedValue, context);
    await adapter.rollback(stagedValue.stagingId, context);
    expect(index.stage).toHaveBeenCalledWith({ plan: value, context });
    expect(index.reuseOrBuildVector).toHaveBeenCalledWith({
      plan: value,
      staged: stagedValue,
      context,
    });
    expect(index.finalize).toHaveBeenCalledWith({
      plan: value,
      staged: stagedValue,
      context,
    });
    expect(index.rollback).toHaveBeenCalledWith({
      stagingId: stagedValue.stagingId,
      context,
    });
  });

  it('TEST-TRAIN-006-BLOCK retains old vectors until the 30 day boundary', () => {
    const availableAt = cleanupAvailableAt(new Date('2026-10-01T00:00:00.000Z'));
    expect(isCleanupCandidateReady(availableAt, new Date('2026-10-30T23:59:59.000Z'))).toBe(false);
    expect(isCleanupCandidateReady(availableAt, new Date('2026-10-31T00:00:00.000Z'))).toBe(true);
  });
});
