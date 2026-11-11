import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('L1 B03B tenant context and ACL concurrency', () => {
  it('L1-B03-AUTH-001-C01 同一 actor 并发切换两个 Workspace 不串用请求上下文', async () => {
    const spaceA = await harness.createSpace(harness.ownerA);
    const spaceB = await harness.createSpace(harness.ownerB);
    const requests = Array.from({ length: 40 }, (_, index) =>
      harness.catalog.listSpaces({}, index % 2 === 0 ? harness.ownerA : harness.ownerB),
    );
    const results = await Promise.all(requests);
    for (const [index, result] of results.entries()) {
      expect(result.items.map((entry) => entry.id)).toEqual([
        index % 2 === 0 ? spaceA.id : spaceB.id,
      ]);
    }
  });

  it('L1-B03-AUTH-003-C01 在途检索持有旧授权时撤权后最终结果不含 Source', async () => {
    const fixture = await harness.createSearchFixture();
    await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    const original = harness.access.batchAuthorizeSources.bind(harness.access);
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolveReached) => {
      markReached = resolveReached;
    });
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const spy = vi
      .spyOn(harness.access, 'batchAuthorizeSources')
      .mockImplementation(async (sourceIds, context) => {
        markReached();
        await gate;
        return original(sourceIds, context);
      });

    const inFlight = harness.hydrate(fixture.candidate, harness.readerA);
    await reached;
    await harness.access.deleteCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      harness.ownerA,
    );
    release();
    await expect(inFlight).resolves.toMatchObject({ items: [], rejected: 1 });
    spy.mockRestore();
  });

  it('L1-B03-AUTH-003-C02 并发重复添加同一协作者只有一个成功另一个稳定冲突', async () => {
    const space = await harness.createSpace();
    const attempts = await Promise.allSettled([
      harness.access.createCollaborator(
        space.id,
        { memberId: harness.readerA.memberId, role: 'read' },
        harness.ownerA,
      ),
      harness.access.createCollaborator(
        space.id,
        { memberId: harness.readerA.memberId, role: 'write' },
        harness.ownerA,
      ),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(
      await harness.models.KnowledgeCollaborator.countDocuments({
        workspaceId: harness.workspaceA,
        knowledgeSpaceId: space.id,
        memberId: harness.readerA.memberId,
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('L1-B03-AUTH-003-C03 Source detach 后同一旧版本的并发 resume 只允许一个', async () => {
    const space = await harness.createSpace();
    const source = await harness.createSource(space.id, harness.ownerA);
    const enabled = await harness.access.transitionSourcePermission(
      source.id,
      'enable',
      {
        version: source.version,
        expectedPermissionRevision: source.permissionRevision,
      },
      harness.ownerA,
    );
    const enabledSource = await harness.catalog.getSource(source.id, harness.ownerA);
    const detached = await harness.access.transitionSourcePermission(
      source.id,
      'detach',
      {
        version: Number(enabledSource.version),
        expectedPermissionRevision: Number(enabled.permissionRevision),
      },
      harness.ownerA,
    );
    const detachedSource = await harness.catalog.getSource(source.id, harness.ownerA);
    const input = {
      version: Number(detachedSource.version),
      expectedPermissionRevision: Number(detached.permissionRevision),
    };
    const attempts = await Promise.allSettled([
      harness.access.transitionSourcePermission(source.id, 'resume', input, harness.ownerA),
      harness.access.transitionSourcePermission(source.id, 'resume', input, harness.ownerA),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });

  it('L1-B03-AUTH-003-C04 已签发 citation 在撤权后最终复核返回不可见', async () => {
    const fixture = await harness.createSearchFixture();
    await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    const hydrated = await harness.hydrate(fixture.candidate, harness.readerA);
    expect(hydrated.items).toHaveLength(1);
    await harness.access.deleteCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      harness.ownerA,
    );
    await expect(
      harness.searchAuthorization.reauthorizeCitation(
        {
          knowledgeSpaceId: fixture.space.id,
          sourceId: fixture.source.id,
          segmentId: fixture.segmentId,
        },
        harness.readerA,
      ),
    ).resolves.toBeUndefined();
  });
});
