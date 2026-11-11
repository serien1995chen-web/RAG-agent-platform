import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openB03BHarness, type B03BHarness } from '../../../../test/fixtures/b03b/harness';

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

describe('L1 B03B tenant security and dependency failure', () => {
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
      harness.fileApplication.content(object.blobId, null, ticket, {
        ...harness.readerA,
        workspaceId: 'ticket',
        memberId: 'ticket',
        scopes: [],
        isWorkspaceOwner: false,
      }),
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
