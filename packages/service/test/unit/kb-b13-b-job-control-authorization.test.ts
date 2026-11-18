import { describe, expect, it, vi } from 'vitest';
import { S06JobApplication } from '../../src/modules/knowledge/application/operations/s06-jobs';
import type { KnowledgeOperationInput } from '../../src/modules/knowledge/application/operation-types';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const sourceId = '65f1e5b2a1c9d4b7e8f01234';
const jobId = '65f1e5b2a1c9d4b7e8f05678';
const context: TenantContext = {
  workspaceId: 'ws_b13b_authorization',
  memberId: 'b13b_member',
  requestId: 'b13b_request',
  traceId: 'b13b_trace',
  scopes: ['knowledge:read', 'knowledge:write'],
  isWorkspaceOwner: false,
};

function input(operationId: string): KnowledgeOperationInput {
  return {
    operationId,
    params: { jobId },
    query: {},
    headers: { 'idempotency-key': `b13b-auth-${operationId}` },
    body: { version: 3 },
    context,
  };
}

describe('B13B Job control authorization', () => {
  it('L1-B13-B-TRAIN-005-A01 control rechecks the owning Source write ACL', async () => {
    const access = {
      assertPermission: vi.fn(),
    };
    const jobs = {
      create: vi.fn(),
      createSourceRebuild: vi.fn(),
      control: vi.fn(async () => ({
        jobId,
        resourceType: 'source',
        resourceId: sourceId,
        status: 'cancelled',
        version: 4,
      })),
    };
    const application = new S06JobApplication(
      jobs,
      {
        createSegment: vi.fn(),
        upsert: vi.fn(),
        remove: vi.fn(),
        reindex: vi.fn(),
        history: vi.fn(),
      },
      {
        getSource: vi.fn(),
        getSegment: vi.fn(),
        getSpace: vi.fn(),
        updateSegment: vi.fn(),
        createSegment: vi.fn(),
        deleteSegment: vi.fn(),
      },
      access,
    );
    await application.dispatch(input('API-JOB-CANCEL'));
    expect(access.assertPermission).toHaveBeenCalledWith('source', sourceId, 'write', context);
  });

  it('L1-B13-B-TRAIN-005-A02 dead-letter replay rejects a non-owner without admin', async () => {
    const jobs = {
      create: vi.fn(),
      createSourceRebuild: vi.fn(),
      control: vi.fn(),
    };
    const application = new S06JobApplication(
      jobs,
      {
        createSegment: vi.fn(),
        upsert: vi.fn(),
        remove: vi.fn(),
        reindex: vi.fn(),
        history: vi.fn(),
      },
      {
        getSource: vi.fn(),
        getSegment: vi.fn(),
        getSpace: vi.fn(),
        updateSegment: vi.fn(),
        createSegment: vi.fn(),
        deleteSegment: vi.fn(),
      },
      { assertPermission: vi.fn() },
    );
    await expect(application.dispatch(input('API-JOB-REPLAY'))).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(jobs.control).not.toHaveBeenCalled();
  });
});
