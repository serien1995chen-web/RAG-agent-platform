import { describe, expect, it } from 'vitest';
import {
  objectIdOf,
  requireWorkspaceId,
  type TenantContext,
} from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b04_security',
  memberId: 'mem_b04_security',
  requestId: 'req_b04_security',
  traceId: 'a'.repeat(32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  isWorkspaceOwner: true,
};

function thrownBy(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as {
      name?: string;
      problem?: { error?: { code?: string; details?: Record<string, unknown> } };
    };
  }
  throw new Error('expected operation to throw');
}

describe('B04 pure input and tenant security', () => {
  it('L1-B04-DATA-001-N02 malformed Segment ID uses the stable validation contract', () => {
    const error = thrownBy(() => objectIdOf('not-an-object-id', context, 'segmentId'));
    expect(error.problem?.error).toMatchObject({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      details: { field: 'segmentId', reason: 'invalid_object_id' },
    });
    expect(error.name).not.toBe('CastError');
  });

  it('L1-B04-DATA-002-N02 missing workspace and member context fail closed', () => {
    expect(
      thrownBy(() =>
        requireWorkspaceId({
          ...context,
          workspaceId: '',
        }),
      ).problem?.error,
    ).toMatchObject({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      details: { field: 'workspaceId', reason: 'required' },
    });
    expect(
      thrownBy(() =>
        requireWorkspaceId({
          ...context,
          memberId: ' ',
        }),
      ).problem?.error,
    ).toMatchObject({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      details: { field: 'memberId', reason: 'required' },
    });
  });

  it('L1-B04-DATA-003-N02 malformed Job ID never exposes BSON or casts internally', () => {
    const error = thrownBy(() => objectIdOf('not-a-job-id', context, 'jobId'));
    expect(error.problem?.error).toMatchObject({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      details: { field: 'jobId', reason: 'invalid_object_id' },
    });
    expect(error.name).not.toBe('CastError');
  });
});
