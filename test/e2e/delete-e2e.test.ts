import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { MemoryIdempotencyStore } from '../../packages/dal/src/index';
import { CompensationApplicationService } from '../../packages/service/src/modules/delete/application/compensation.service';
import { ReconcileApplicationService } from '../../packages/service/src/modules/delete/application/reconcile.service';
import { S3TtlService } from '../../packages/service/src/modules/delete/application/s3-ttl.service';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';
import datasetDeleteRoute from '../../projects/app/src/pages/api/core/dataset/delete';

const context: RequestContext = {
  requestId: 'req-delete-e2e',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000101';
const fixedNow = new Date('2026-10-14T12:00:00.000Z');
const state = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body }) };
}

function request(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

describe('P6-07 lifecycle E2E batch', () => {
  it('TEST-RECON-TTL-001 never deletes an object with a formal reference', async () => {
    const deletes: string[] = [];
    const service = new S3TtlService({
      repository: {
        claimBatch: async () => [
          {
            id: 'ttl-formal',
            teamId: context.tenant.teamId,
            bucketName: 'kb-local',
            objectKey: `temp/${context.tenant.teamId}/formal.txt`,
            expireAt: new Date(fixedNow.getTime() - 10 * 60_000),
            attempt: 0,
            operationId: 'ttl-formal-op',
            resourceRef: { resourceType: 'object', resourceId: 'formal.txt', version: 1 },
          },
        ],
        markFailed: async () => true,
        deleteRecord: async () => true,
        backfill: async () => undefined,
        hasFormalReference: async () => true,
        hasTtlRecord: async () => true,
        resolveDatasetTeamId: async () => context.tenant.teamId,
      },
      objectStore: {
        abort: async () => ({ aborted: true }),
        delete: async (input: { ref: { key: string } }) => {
          deletes.push(input.ref.key);
          return { deleted: true };
        },
      } as never,
      clock: () => fixedNow,
    });
    expect(await service.sweepOnce(context)).toEqual({
      scanned: 1,
      deleted: 1,
      failed: 0,
      skipped: 0,
    });
    expect(deletes).toEqual([]);
  });

  it('TEST-RECON-VEC-001 / ACC-RECON-003 converges vector and object orphans', async () => {
    const vectorDeletes: string[] = [];
    const objectDeletes: string[] = [];
    const cleaned = new Set<string>();
    const operations = [
      {
        operationId: `delete-vector:${context.tenant.teamId}:${datasetId}:old-vector:1`,
        teamId: context.tenant.teamId,
        operation: 'delete_vector',
        stage: 'projection_pending',
        attempt: 0,
        resourceRef: { resourceType: 'vector', resourceId: 'old-vector', version: 1 },
        nextAttemptAt: new Date(fixedNow.getTime() - 1_000),
        leaseOwner: null,
        leaseExpireAt: null,
      },
      {
        operationId: `delete-s3:${context.tenant.teamId}:object-hash:1`,
        teamId: context.tenant.teamId,
        operation: 'delete_s3',
        stage: 'projection_pending',
        attempt: 0,
        resourceRef: {
          resourceType: 'object',
          resourceId: `dataset/${datasetId}/orphan.bin`,
          version: 1,
        },
        nextAttemptAt: new Date(fixedNow.getTime() - 1_000),
        leaseOwner: null,
        leaseExpireAt: null,
      },
    ];
    const service = new CompensationApplicationService({
      crossStore: {
        claimExpiredLease: async () =>
          operations.filter((operation) => !cleaned.has(operation.operationId)),
        markStage: async (input: { operationId: string; stage: string }) => {
          if (input.stage === 'cleaned') cleaned.add(input.operationId);
          return true;
        },
        listByJob: async () => operations,
        resetNextAttempt: async () => operations.length,
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async (input: { dataIds?: string[] }) => {
          vectorDeletes.push(...(input.dataIds ?? []));
          return { deleted: input.dataIds?.length ?? 0 };
        },
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      objectStore: {
        abort: async () => ({ aborted: true }),
        delete: async (input: { ref: { key: string } }) => {
          objectDeletes.push(input.ref.key);
          return { deleted: true };
        },
      } as never,
      hasFormalReference: async () => false,
      hasLiveReference: async () => false,
      clock: () => fixedNow,
    });
    expect(await service.sweepOnce(context)).toEqual({
      scanned: 2,
      cleaned: 2,
      failed: 0,
      skipped: 0,
    });
    expect(vectorDeletes).toEqual(['old-vector']);
    expect(objectDeletes).toEqual([`dataset/${datasetId}/orphan.bin`]);
  });

  it('ACC-RECON-001/003 apply cleanup removes ACL and Training orphans only', async () => {
    let aclDeletes = 0;
    let trainingDeletes = 0;
    const service = new ReconcileApplicationService({
      facts: {
        scanVectorCandidates: async () => ({
          datasets: [],
          liveDataIds: [],
          liveDatasetIds: [],
          liveCollectionIds: [],
        }),
        scanFulltextCandidates: async () => [],
        scanAclOrphans: async () => [
          { id: 'acl-1', teamId: context.tenant.teamId, resourceId: datasetId },
        ],
        scanTrainingOrphans: async () => [
          {
            id: 'training-1',
            teamId: context.tenant.teamId,
            datasetId,
            collectionId: 'collection-deleted',
          },
        ],
        scanStuckDeleteJobs: async () => [],
        scanFailedCrossStoreOps: async () => [],
        hasTtlRecord: async () => true,
        deleteAclRows: async () => {
          aclDeletes += 1;
          return 1;
        },
        deleteTrainingRows: async () => {
          trainingDeletes += 1;
          return 1;
        },
        requeueStuckJob: async () => 'requeued',
      },
      reports: {
        start: async () => undefined,
        finish: async () => true,
        listReports: async () => ({ total: 0, list: [] }),
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => ({ deleted: 0 }),
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      clock: () => fixedNow,
    });
    await service.run(
      {
        windowStart: new Date(fixedNow.getTime() - 6 * 3_600_000),
        windowEnd: new Date(fixedNow.getTime() - 2 * 3_600_000),
        scope: { kind: 'global' },
        mode: 'apply',
      },
      context,
    );
    expect({ aclDeletes, trainingDeletes }).toEqual({ aclDeletes: 1, trainingDeletes: 1 });
  });

  it('TEST-E2E-DELETE-001 cross-tenant delete is rejected with 501070 and zero side effects', async () => {
    const requestDatasetDelete = vi.fn(async () => ({ jobId: 'must-not-run', state: 'queued' }));
    state.runtime = {
      clients: { idempotencyStore: new MemoryIdempotencyStore() },
      datasetPermission: {
        async getPermission() {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: context.requestId,
              params: { resourceType: 'dataset', resourceId: datasetId },
            }),
          );
        },
      },
      deleteService: { requestDatasetDelete },
    };
    const recorder = responseRecorder();
    await datasetDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/delete',
        headers: { 'idempotency-key': 'cross-tenant-delete' },
        body: { datasetId },
      }),
      recorder.response,
    );
    expect((recorder.result().body as { code: number }).code).toBe(501070);
    expect(requestDatasetDelete).not.toHaveBeenCalled();
  });
});
