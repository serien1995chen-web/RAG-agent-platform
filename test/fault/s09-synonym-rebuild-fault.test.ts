import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import type { S6JobRecord } from '../../packages/service/src/modules/knowledge/application/s06-processing-ports';
import { S09RebuildApplication } from '../../packages/service/src/modules/knowledge/application/s09-rebuild.application';
import {
  buildRebuildPlan,
  type SynonymStagedRebuild,
} from '../../packages/service/src/modules/knowledge/domain/s09-synonym-rebuild';

const context: TenantContext = {
  workspaceId: 'ws_s9_fault',
  memberId: 'system:knowledge-worker',
  requestId: 'req_s9_fault',
  traceId: 'trace_s9_fault'.padEnd(32, '0'),
  scopes: ['knowledge:admin'],
};
const jobId = '65f1e5b2a1c9d4b7e8f09999';
const spaceId = '65f1e5b2a1c9d4b7e8f01234';

function plan() {
  return buildRebuildPlan({
    jobId,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: spaceId,
    reason: 'synonym_change',
    candidateFileVersion: 3,
    expectedActiveFileVersion: 2,
    oldPublishedFileVersion: 2,
    sourceIds: ['65f1e5b2a1c9d4b7e8f01111'],
    indexedSegmentVersions: {},
    oldQueryModelId: 'embedding-768',
    oldQueryDimension: 768,
    targetModelId: 'embedding-1536',
    targetDimension: 1536,
  });
}

describe('TEST-X-PGVECTOR-PARTIAL S9 synonym rebuild fault', () => {
  it('keeps the old version and compensates a partial staged rebuild', async () => {
    let status = 'queued';
    const staged: SynonymStagedRebuild = {
      stagingId: 'stage-partial',
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      candidateFileVersion: 3,
      sourceIds: ['65f1e5b2a1c9d4b7e8f01111'],
      indexedSegmentVersions: {},
      reusedVectorCount: 1,
      rebuiltCount: 1,
      cleanupCandidates: [],
      failureEvidence: null,
    };
    const rollback = vi.fn(async () => undefined);
    const failRebuild = vi.fn(async () => undefined);
    const completeRebuild = vi.fn(async () => undefined);
    const app = new S09RebuildApplication({
      repository: {
        async getRebuildPlan() {
          return plan();
        },
        completeRebuild,
        failRebuild,
      },
      s6: {
        async stageProfile() {
          return staged;
        },
        async reuseOrBuildVector(_plan, value) {
          return value;
        },
        async finalize() {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: true,
            details: { dependency: 'pgvector', partial: true },
          });
        },
        rollback,
      },
      jobs: {
        async getRaw() {
          const value = {
            _id: jobId,
            kind: 'synonym_rebuild',
            status,
            fencingToken: 'fencing-1',
          } as unknown as S6JobRecord;
          status = status === 'queued' ? 'leased' : status;
          return value;
        },
        async claimById() {
          return { version: 2, attemptEpoch: 1 };
        },
        async start() {
          status = 'running';
          return { version: 3, attemptEpoch: 1 };
        },
        async setStep() {
          return undefined;
        },
      },
    });
    await expect(app.handleQueue(jobId, 'worker-fault', context)).resolves.toBe('retry');
    expect(rollback).toHaveBeenCalledWith(staged.stagingId, context);
    expect(completeRebuild).not.toHaveBeenCalled();
    expect(failRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ oldPublishedFileVersion: 2 }),
      expect.objectContaining({
        retryable: true,
        errorCode: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      }),
      context,
    );
  });
});
