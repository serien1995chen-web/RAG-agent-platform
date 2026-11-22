import { describe, expect, it, vi } from 'vitest';
import { KnowledgeApiError } from '../../packages/contracts/src';
import {
  KnowledgeScopedAuthAdapter,
  type KnowledgeAccessRepository,
} from '../../packages/service/src';
import type { TenantContext } from '../../packages/service/src';

const workspaceA = 'ws_b18b_tenant_a';
const workspaceB = 'ws_b18b_tenant_b';
const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const context: TenantContext = {
  workspaceId: workspaceA,
  memberId: 'mem_b18b',
  requestId: 'req-b18b-tenant',
  traceId: 'a'.repeat(32),
  scopes: ['knowledge:read', 'knowledge:search'],
  apiKeyId: '65f1e5b2a1c9d4b7e8f05678',
  apiKeyPrefix: 'kn_live_test',
  apiKeySpaceIds: [spaceA],
};

function adapter(assertPermission = vi.fn()) {
  return {
    access: assertPermission,
    value: new KnowledgeScopedAuthAdapter({
      assertPermission,
    } as unknown as KnowledgeAccessRepository),
  };
}

function expectProblem(error: unknown, code: string) {
  expect(error).toBeInstanceOf(KnowledgeApiError);
  expect((error as KnowledgeApiError).problem.error.code).toBe(code);
}

describe('TEST-X-TENANT-GUARD B18-B downstream authorization', () => {
  it('rejects a Key subject that claims another workspace before repository access', async () => {
    const { value, access } = adapter();
    try {
      await value.authorize({
        subject: {
          authType: 'api_key',
          memberId: 'mem_b18b',
          workspaceIds: [workspaceA],
          scopes: ['knowledge:read', 'knowledge:search'],
        },
        workspaceId: workspaceB,
        knowledgeSpaceId: spaceA,
        requiredScope: 'knowledge:read',
        context: { ...context, workspaceId: workspaceB },
      });
      throw new Error('expected authorization failure');
    } catch (error) {
      expectProblem(error, 'KNOWLEDGE_FORBIDDEN');
      expect((error as KnowledgeApiError).problem.error.details).toMatchObject({
        reason: 'workspace_mismatch',
      });
    }
    expect(access).not.toHaveBeenCalled();
  });

  it('rejects missing write scope before repository access', async () => {
    const { value, access } = adapter();
    try {
      await value.authorize({
        subject: {
          authType: 'api_key',
          memberId: 'mem_b18b',
          workspaceIds: [workspaceA],
          scopes: ['knowledge:read', 'knowledge:search'],
        },
        workspaceId: workspaceA,
        knowledgeSpaceId: spaceA,
        requiredScope: 'knowledge:write',
        context,
      });
      throw new Error('expected authorization failure');
    } catch (error) {
      expectProblem(error, 'KNOWLEDGE_FORBIDDEN');
      expect((error as KnowledgeApiError).problem.error.details).toMatchObject({
        requiredScope: 'knowledge:write',
      });
    }
    expect(access).not.toHaveBeenCalled();
  });

  it('rejects a Space outside Key scope even when the resource exists', async () => {
    const { value, access } = adapter();
    try {
      await value.authorize({
        subject: {
          authType: 'api_key',
          memberId: 'mem_b18b',
          workspaceIds: [workspaceA],
          scopes: ['knowledge:read', 'knowledge:search'],
        },
        workspaceId: workspaceA,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01235',
        requiredScope: 'knowledge:read',
        context,
      });
      throw new Error('expected authorization failure');
    } catch (error) {
      expectProblem(error, 'KNOWLEDGE_FORBIDDEN');
      expect((error as KnowledgeApiError).problem.error.details).toMatchObject({
        reason: 'api_key_space_scope',
      });
    }
    expect(access).not.toHaveBeenCalled();
  });

  it('reaches the ACL repository only after workspace, scope and Space scope pass', async () => {
    const { value, access } = adapter(vi.fn().mockResolvedValue({ effectivePermission: 'read' }));
    await expect(
      value.authorize({
        subject: {
          authType: 'api_key',
          memberId: 'mem_b18b',
          workspaceIds: [workspaceA],
          scopes: ['knowledge:read', 'knowledge:search'],
        },
        workspaceId: workspaceA,
        knowledgeSpaceId: spaceA,
        requiredScope: 'knowledge:read',
        context,
      }),
    ).resolves.toBeUndefined();
    expect(access).toHaveBeenCalledWith('space', spaceA, 'read', context);
  });
});
