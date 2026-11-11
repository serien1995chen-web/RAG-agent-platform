import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  extendedContext,
  openB03BHarness,
  type B03BHarness,
} from '../../../../test/fixtures/b03b/harness';

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

describe('L1 B03B tenant, collaboration, ACL snapshot and final search authorization', () => {
  it('L1-B03-AUTH-001-P01 合法 Workspace 归属贯穿写入详情搜索和对象 ticket', async () => {
    const fixture = await harness.createSearchFixture();
    await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    const object = await harness.createSourceObject({
      spaceId: fixture.space.id,
      sourceId: fixture.source.id,
    });

    const space = await harness.catalog.getSpace(fixture.space.id, harness.readerA);
    const source = await harness.catalog.getSource(fixture.source.id, harness.readerA);
    const hydrated = await harness.hydrate(fixture.candidate, harness.readerA);
    const ticket = await harness.fileApplication.preview(
      object.blobId,
      { ttlSeconds: 60 },
      harness.readerA,
    );

    expect(space.id).toBe(fixture.space.id);
    expect(source.id).toBe(fixture.source.id);
    expect(hydrated.items).toHaveLength(1);
    expect(ticket).toMatchObject({
      disposition: 'inline',
      expiresAt: expect.any(String),
    });
    for (const model of [
      harness.models.KnowledgeSpace,
      harness.models.KnowledgeSource,
      harness.models.KnowledgeSegment,
      harness.models.KnowledgeObjectRef,
    ]) {
      expect(
        await model.countDocuments({
          workspaceId: harness.workspaceA,
          createdByMemberId: harness.ownerA.memberId,
        }),
      ).toBeGreaterThan(0);
    }
  });

  it('L1-B03-AUTH-001-N01 缺失 member 和伪造 context 被稳定拒绝且不写入', async () => {
    const before = await harness.models.KnowledgeSpace.countDocuments({
      workspaceId: harness.workspaceA,
    });
    const invalid = {
      ...harness.ownerA,
      memberId: '',
    };
    await expect(
      harness.catalog.createSpace(
        {
          kind: 'space',
          name: `invalid member ${harness.suffix}`,
          accessMode: 'restricted',
          sourceAclMode: 'inherited',
          sourcePermissionEnabled: true,
        },
        invalid,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'memberId' },
        },
      },
    });
    expect(
      await harness.models.KnowledgeSpace.countDocuments({
        workspaceId: harness.workspaceA,
      }),
    ).toBe(before);
  });

  it('L1-B03-AUTH-001-A01 跨租户详情更新删除导出队列和对象读取均同形拒绝', async () => {
    const local = await harness.createSpace(harness.ownerA);
    const foreign = await harness.createSpace(harness.ownerB, {
      name: `foreign ${harness.suffix}`,
    });
    const foreignSource = await harness.createSource(foreign.id, harness.ownerB);
    const foreignObject = await harness.createSourceObject({
      spaceId: foreign.id,
      sourceId: foreignSource.id,
      context: harness.ownerB,
    });
    const foreignJob = await harness.archive.createExportJob(
      {
        spaceId: foreign.id,
        sourceIds: [],
        idempotencyKey: `b03b-foreign-export-${harness.suffix}`,
        exportScope: 'space',
      },
      harness.ownerB,
    );

    const attempts = [
      ['space detail', () => harness.catalog.getSpace(foreign.id, harness.ownerA)],
      ['source detail', () => harness.catalog.getSource(foreignSource.id, harness.ownerA)],
      [
        'space update',
        () =>
          harness.catalog.updateSpace(
            foreign.id,
            { version: foreign.version, name: 'cross tenant update' },
            harness.ownerA,
          ),
      ],
      [
        'source delete',
        () => harness.catalog.deleteSource(foreignSource.id, harness.ownerA, foreignSource.version),
      ],
      ['export job detail', () => harness.archive.get(String(foreignJob.jobId), harness.ownerA)],
      [
        'object ticket',
        () =>
          harness.fileApplication.preview(foreignObject.blobId, { ttlSeconds: 60 }, harness.ownerA),
      ],
    ] as const;
    for (const [label, attempt] of attempts) {
      const error = await attempt().catch((caught) => caught);
      expect(error, label).toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      });
    }
    await expect(harness.catalog.getSpace(local.id, harness.ownerA)).resolves.toMatchObject({
      id: local.id,
    });
  });

  it('L1-B03-AUTH-001-S01 拒绝请求不创建业务文档导出对象队列任务或假成功审计', async () => {
    const local = await harness.createSpace(harness.ownerA);
    const foreignSource = await harness.createSource(
      (
        await harness.createSpace(harness.ownerB, {
          name: `foreign source space ${harness.suffix}`,
        })
      ).id,
      harness.ownerB,
    );
    const before = {
      sources: await harness.models.KnowledgeSource.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      jobs: await harness.models.KnowledgeJob.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      objects: await harness.models.KnowledgeObjectRef.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      audits: await harness.models.KnowledgeAuditEvent.countDocuments({
        workspaceId: harness.workspaceA,
      }),
    };
    await expect(
      harness.catalog.createSource(
        local.id,
        {
          kind: 'text',
          name: 'foreign source reference',
          directoryId: new Types.ObjectId().toString(),
        },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      harness.catalog.deleteSource(foreignSource.id, harness.ownerA),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect({
      sources: await harness.models.KnowledgeSource.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      jobs: await harness.models.KnowledgeJob.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      objects: await harness.models.KnowledgeObjectRef.countDocuments({
        workspaceId: harness.workspaceA,
      }),
      audits: await harness.models.KnowledgeAuditEvent.countDocuments({
        workspaceId: harness.workspaceA,
      }),
    }).toEqual(before);
  });

  it('L1-B03-AUTH-003-P01 添加更新协作者刷新后检索命中撤权后详情搜索和 ticket 均拒绝', async () => {
    const fixture = await harness.createSearchFixture();
    const object = await harness.createSourceObject({
      spaceId: fixture.space.id,
      sourceId: fixture.source.id,
    });
    const created = await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    expect((await harness.hydrate(fixture.candidate, harness.readerA)).items).toHaveLength(1);
    const updated = await harness.access.updateCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      { role: 'write', version: created.version },
      harness.ownerA,
    );
    expect(updated).toMatchObject({ memberId: harness.readerA.memberId, role: 'write' });
    expect(
      (
        await harness.application.dispatch({
          operationId: 'API-COLLABORATOR-LIST',
          params: { spaceId: fixture.space.id },
          query: {},
          body: {},
          headers: {},
          context: harness.ownerA,
        })
      ).data,
    ).toMatchObject({
      items: [expect.objectContaining({ memberId: harness.readerA.memberId, role: 'write' })],
    });
    await harness.access.deleteCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      harness.ownerA,
    );
    expect((await harness.hydrate(fixture.candidate, harness.readerA)).items).toEqual([]);
    await expect(
      harness.application.dispatch({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: fixture.source.id },
        query: {},
        body: {},
        headers: {},
        context: harness.readerA,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: expect.stringMatching(/KNOWLEDGE_(FORBIDDEN|NOT_FOUND)/) } },
    });
    await expect(
      harness.fileApplication.download(object.blobId, { ttlSeconds: 60 }, harness.readerA),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(
      await harness.models.KnowledgeSource.countDocuments({
        workspaceId: harness.workspaceA,
        _id: new Types.ObjectId(fixture.source.id),
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('L1-B03-AUTH-003-N01 重复协作者返回稳定冲突且非法角色不落库', async () => {
    const space = await harness.createSpace();
    await harness.access.createCollaborator(
      space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    await expect(
      harness.access.createCollaborator(
        space.id,
        { memberId: harness.readerA.memberId, role: 'read' },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    await expect(
      harness.access.createCollaborator(
        space.id,
        { memberId: harness.managerA.memberId, role: 'owner' },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(
      await harness.models.KnowledgeCollaborator.countDocuments({
        workspaceId: harness.workspaceA,
        memberId: harness.managerA.memberId,
      }),
    ).toBe(0);
  });

  it('L1-B03-AUTH-003-N02 Source 权限关闭时禁止查询 Source ACL', async () => {
    const space = await harness.createSpace(harness.ownerA, {
      sourcePermissionEnabled: false,
    });
    const source = await harness.createSource(space.id, harness.ownerA);
    await expect(harness.access.getAcl('source', source.id, harness.ownerA)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(
      await harness.models.KnowledgeResourcePermission.countDocuments({
        workspaceId: harness.workspaceA,
        resourceType: 'source',
        resourceId: new Types.ObjectId(source.id),
        principalId: harness.readerA.memberId,
      }),
    ).toBe(0);
  });

  it('L1-B03-AUTH-003-N03 Source 权限关闭时 ACL 修改也不得落库', async () => {
    const space = await harness.createSpace(harness.ownerA, {
      sourcePermissionEnabled: false,
    });
    const source = await harness.createSource(space.id, harness.ownerA);
    await expect(
      harness.access.updateAcl(
        'source',
        source.id,
        {
          version: source.version,
          inheritMode: 'override',
          entries: [
            {
              principalType: 'member',
              principalId: harness.readerA.memberId,
              permission: 'read',
            },
          ],
        },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(
      await harness.models.KnowledgeResourcePermission.countDocuments({
        workspaceId: harness.workspaceA,
        resourceType: 'source',
        resourceId: new Types.ObjectId(source.id),
        principalId: harness.readerA.memberId,
      }),
    ).toBe(0);
  });

  it('L1-B03-AUTH-003-A01 只读协作者不能读取协作者管理数据', async () => {
    const space = await harness.createSpace(harness.ownerA, { accessMode: 'restricted' });
    await harness.access.createCollaborator(
      space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    await expect(
      harness.application.dispatch({
        operationId: 'API-COLLABORATOR-LIST',
        params: { spaceId: space.id },
        query: {},
        body: {},
        headers: {},
        context: harness.readerA,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
  });

  it('L1-B03-AUTH-003-A04 无权限成员列表不显示受限知识库', async () => {
    const space = await harness.createSpace(harness.ownerA, { accessMode: 'restricted' });
    const outsider = {
      ...harness.readerA,
      memberId: `mem_b03b_outsider_${harness.suffix}`,
    };
    const listed = await harness.application.dispatch({
      operationId: 'API-SPACE-LIST',
      params: {},
      query: {},
      body: {},
      headers: {},
      context: outsider,
    });
    expect((listed.data as { items: Array<{ id: string }> }).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: space.id })]),
    );
  });

  it('L1-B03-AUTH-003-A02 组织和群组 ACL 主体按 FastGPT 继承语义生效且不跨 Workspace', async () => {
    const space = await harness.createSpace();
    const groupId = `group_b03b_${harness.suffix}`;
    await harness.models.KnowledgeResourcePermission.create({
      workspaceId: harness.workspaceA,
      knowledgeSpaceId: new Types.ObjectId(space.id),
      version: 1,
      deletedAt: null,
      createdByMemberId: harness.ownerA.memberId,
      updatedByMemberId: harness.ownerA.memberId,
      resourceType: 'space',
      resourceId: new Types.ObjectId(space.id),
      principalType: 'group',
      principalId: groupId,
      permission: 'read',
      inheritMode: 'override',
      snapshotVersion: 1,
    });
    const groupMember = extendedContext(harness.readerA, { groupIds: [groupId] });
    await expect(
      harness.access.assertPermission('space', space.id, 'read', groupMember),
    ).resolves.toMatchObject({ resourceId: new Types.ObjectId(space.id) });
    const foreignGroupMember = extendedContext(
      { ...groupMember, workspaceId: harness.workspaceB },
      { groupIds: [groupId] },
    );
    await expect(
      harness.access.assertPermission('space', space.id, 'read', foreignGroupMember),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('L1-B03-AUTH-003-S01 协作者与 ACL revision 审计原子更新撤权不删除 Source Segment 或对象', async () => {
    const fixture = await harness.createSearchFixture();
    const object = await harness.createSourceObject({
      spaceId: fixture.space.id,
      sourceId: fixture.source.id,
    });
    const before = await harness.models.KnowledgeSpace.findOne({
      workspaceId: harness.workspaceA,
      _id: new Types.ObjectId(fixture.space.id),
    }).lean();
    await harness.access.createCollaborator(
      fixture.space.id,
      { memberId: harness.readerA.memberId, role: 'read' },
      harness.ownerA,
    );
    const afterCreate = await harness.models.KnowledgeSpace.findOne({
      workspaceId: harness.workspaceA,
      _id: new Types.ObjectId(fixture.space.id),
    }).lean();
    expect(afterCreate?.permissionRevision).toBe((before?.permissionRevision ?? 0) + 1);
    await harness.access.deleteCollaborator(
      fixture.space.id,
      harness.readerA.memberId,
      harness.ownerA,
    );
    expect(
      await harness.models.KnowledgeAuditEvent.countDocuments({
        workspaceId: harness.workspaceA,
        knowledgeSpaceId: new Types.ObjectId(fixture.space.id),
        action: { $in: ['collaborator.create', 'collaborator.delete'] },
        outcome: 'succeeded',
      }),
    ).toBe(2);
    expect(
      await harness.models.KnowledgeSource.countDocuments({
        workspaceId: harness.workspaceA,
        _id: new Types.ObjectId(fixture.source.id),
      }),
    ).toBe(1);
    expect(
      await harness.models.KnowledgeSegment.countDocuments({
        workspaceId: harness.workspaceA,
        _id: new Types.ObjectId(fixture.segmentId),
      }),
    ).toBe(1);
    expect(await harness.objectRefs.findObjectRef(object.blobId, harness.ownerA)).toMatchObject({
      blobId: object.blobId,
      state: 'active',
    });
  });
});
