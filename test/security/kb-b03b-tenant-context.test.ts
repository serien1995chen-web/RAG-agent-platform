import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeMockAuthProvider } from '../../packages/service/src/modules/knowledge/adapter/auth.adapter';
import { createConsoleSession } from '../../packages/service/src/modules/knowledge/adapter/console-session';
import { KnowledgeScopedAuthAdapter } from '../../packages/service/src/modules/knowledge/adapter/s10-scoped-auth.adapter';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { openB03BHarness, type B03BHarness } from '../fixtures/b03b/harness';

let harness: B03BHarness;

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0';
  harness = await openB03BHarness();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness?.cleanup();
});

function ticketContext(context: TenantContext): TenantContext {
  return {
    ...context,
    workspaceId: 'ticket',
    memberId: 'ticket',
    scopes: [],
    isWorkspaceOwner: false,
  };
}

describe('L1 B03B tenant context and dependency failure security', () => {
  it('L1-B03-AUTH-001-N02 伪造或跨 Workspace Console Session 稳定拒绝', async () => {
    const token = `b03b-auth-token-${harness.suffix}`;
    const provider = new KnowledgeMockAuthProvider(
      {
        mode: 'mock',
        fixture: {
          token,
          workspaceId: harness.workspaceA,
          memberId: harness.ownerA.memberId,
          scopes: ['knowledge:read'],
          isWorkspaceOwner: false,
        },
      } as never,
      'test',
    );
    const validSession = createConsoleSession(
      {
        workspaceId: harness.workspaceA,
        memberId: harness.readerA.memberId,
        scopes: ['knowledge:read'],
        isWorkspaceOwner: false,
      },
      token,
    );
    await expect(
      provider.authenticate({
        authorization: undefined,
        workspaceId: harness.workspaceA,
        requestId: 'req_b03b_session_ok',
        traceId: 'trace_b03b_session_ok',
        consoleSession: validSession,
      }),
    ).resolves.toMatchObject({
      memberId: harness.readerA.memberId,
      workspaceIds: [harness.workspaceA],
    });
    await expect(
      provider.authenticate({
        authorization: undefined,
        workspaceId: harness.workspaceB,
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
        workspaceId: harness.workspaceA,
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
        workspaceIds: [harness.workspaceA],
        scopes: ['knowledge:write'],
      },
      workspaceId: harness.workspaceA,
      knowledgeSpaceId: 'knowledge-space-a',
      requiredScope: 'knowledge:write' as const,
      context: {
        ...harness.ownerA,
        apiKeySpaceIds: ['knowledge-space-b'],
      },
    };

    await expect(adapter.authorize(base)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(
      adapter.authorize({
        ...base,
        workspaceId: harness.workspaceB,
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

  it('L1-B03-AUTH-003-N03 空 ACL 快照不能让 Workspace 成员获得全球可读', async () => {
    const fixture = await harness.createSearchFixture();
    expect(
      await harness.access.batchAuthorizeSources([fixture.source.id], harness.readerA),
    ).toEqual([]);
    expect((await harness.hydrate(fixture.candidate, harness.readerA)).items).toEqual([]);
  });

  it('L1-B03-AUTH-003-A03 文件 ticket 绑定 Workspace 且撤权后旧 ticket 在最终读取点失败', async () => {
    const fixture = await harness.createSearchFixture();
    const object = await harness.createSourceObject({
      spaceId: fixture.space.id,
      sourceId: fixture.source.id,
    });
    await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    const preview = await harness.fileApplication.preview(
      object.blobId,
      { ttlSeconds: 60 },
      harness.readerA,
    );
    const ticket = new URL(preview.url).searchParams.get('ticket');
    expect(ticket).toBeTruthy();
    await expect(
      harness.fileApplication.content(object.blobId, null, ticket, {
        ...harness.ownerB,
        workspaceId: harness.workspaceB,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });

    await harness.access.deleteCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      harness.ownerA,
    );
    await expect(
      harness.fileApplication.content(object.blobId, null, ticket, ticketContext(harness.readerA)),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('L1-B03-AUTH-001-F01 搜索授权 Mongo 不可用时返回依赖错误而不是未过滤结果', async () => {
    const isolated = await openB03BHarness(`dep${harness.suffix}`);
    const fixture = await isolated.createSearchFixture();
    await isolated.cleanup();
    await expect(isolated.hydrate(fixture.candidate, isolated.ownerA)).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          details: expect.objectContaining({ dependency: 'mongo' }),
        },
      },
    });
  });
});
