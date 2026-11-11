import { describe, expect, it, vi } from 'vitest';
import { KnowledgeMockAuthProvider } from '../../packages/service/src/modules/knowledge/adapter/auth.adapter';
import { createConsoleSession } from '../../packages/service/src/modules/knowledge/adapter/console-session';
import { KnowledgeScopedAuthAdapter } from '../../packages/service/src/modules/knowledge/adapter/s10-scoped-auth.adapter';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const workspaceA = 'ws_b03b_security_a';
const workspaceB = 'ws_b03b_security_b';
const ownerA: TenantContext = {
  workspaceId: workspaceA,
  memberId: 'mem_b03b_security_owner',
  requestId: 'req_b03b_security_owner',
  traceId: 'trace_b03b_security_owner',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

describe('L1 B03B tenant context security', () => {
  it('L1-B03-AUTH-001-N02 伪造或跨 Workspace Console Session 稳定拒绝', async () => {
    const token = 'b03b-auth-token-security';
    const provider = new KnowledgeMockAuthProvider(
      {
        mode: 'mock',
        fixture: {
          token,
          workspaceId: workspaceA,
          memberId: ownerA.memberId,
          scopes: ['knowledge:read'],
          isWorkspaceOwner: false,
        },
      } as never,
      'test',
    );
    const validSession = createConsoleSession(
      {
        workspaceId: workspaceA,
        memberId: 'mem_b03b_security_reader',
        scopes: ['knowledge:read'],
        isWorkspaceOwner: false,
      },
      token,
    );
    await expect(
      provider.authenticate({
        authorization: undefined,
        workspaceId: workspaceA,
        requestId: 'req_b03b_session_ok',
        traceId: 'trace_b03b_session_ok',
        consoleSession: validSession,
      }),
    ).resolves.toMatchObject({
      memberId: 'mem_b03b_security_reader',
      workspaceIds: [workspaceA],
    });
    await expect(
      provider.authenticate({
        authorization: undefined,
        workspaceId: workspaceB,
        requestId: 'req_b03b_session_foreign',
        traceId: 'trace_b03b_session_foreign',
        consoleSession: validSession,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(
      provider.authenticate({
        authorization: undefined,
        workspaceId: workspaceA,
        requestId: 'req_b03b_tampered',
        traceId: 'trace_b03b_tampered',
        consoleSession: `${validSession.slice(0, -1)}x`,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } },
    });
  });

  it('L1-B03-AUTH-001-A03 API Key scope 与 Workspace 不匹配时在 ACL 查询前拒绝', async () => {
    const assertPermission = vi.fn();
    const adapter = new KnowledgeScopedAuthAdapter({
      assertPermission,
    } as never);
    const base = {
      subject: {
        authType: 'api_key' as const,
        memberId: 'api-key:test',
        workspaceIds: [workspaceA],
        scopes: ['knowledge:write'],
      },
      workspaceId: workspaceA,
      knowledgeSpaceId: 'knowledge-space-a',
      requiredScope: 'knowledge:write' as const,
      context: {
        ...ownerA,
        apiKeySpaceIds: ['knowledge-space-b'],
      },
    };

    await expect(adapter.authorize(base)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(
      adapter.authorize({
        ...base,
        workspaceId: workspaceB,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(
      adapter.authorize({
        ...base,
        subject: { ...base.subject, scopes: ['knowledge:read'] },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(assertPermission).not.toHaveBeenCalled();
  });
});
