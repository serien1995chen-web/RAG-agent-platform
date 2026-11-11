import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openB03BHarness, type B03BHarness } from '../fixtures/b03b/harness';
import { workspaceFilter } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const root = resolve(import.meta.dirname, '../..');
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

async function repositorySourceFiles(): Promise<Array<{ path: string; content: string }>> {
  const directory = join(root, 'packages', 'service', 'src', 'modules', 'knowledge', 'repository');
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.ts'))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => ({
      path: join(directory, name),
      content: await readFile(join(directory, name), 'utf8'),
    })),
  );
}

describe('L1 B03B tenant guard and repository audit', () => {
  it('L1-B03-AUTH-001-N01 空 Workspace 上下文 fail closed 而非返回空列表', async () => {
    expect(() =>
      workspaceFilter({
        ...harness.ownerA,
        workspaceId: '   ',
      }),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            details: expect.objectContaining({ field: 'workspaceId' }),
          }),
        }),
      }),
    );
    await expect(
      harness.catalog.listSpaces(
        {},
        {
          ...harness.ownerA,
          workspaceId: '',
        },
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'workspaceId' },
        },
      },
    });
  });

  it('L1-B03-AUTH-001-N03 空 Member 上下文在 repository 过滤前 fail closed', async () => {
    expect(() =>
      workspaceFilter({
        ...harness.ownerA,
        memberId: ' ',
      }),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            details: expect.objectContaining({ field: 'memberId' }),
          }),
        }),
      }),
    );
  });

  it('L1-B03-AUTH-001-A01 双 Workspace 列表详情队列对象和聚合不互相混用', async () => {
    const spaceA = await harness.createSpace(harness.ownerA);
    const sourceA = await harness.createSource(spaceA.id, harness.ownerA);
    const objectA = await harness.createSourceObject({
      spaceId: spaceA.id,
      sourceId: sourceA.id,
    });
    const jobA = await harness.archive.createExportJob(
      {
        spaceId: spaceA.id,
        sourceIds: [],
        idempotencyKey: `b03b-tenant-a-${harness.suffix}`,
        exportScope: 'space',
      },
      harness.ownerA,
    );

    const spaceB = await harness.createSpace(harness.ownerB);
    const sourceB = await harness.createSource(spaceB.id, harness.ownerB);
    const objectB = await harness.createSourceObject({
      spaceId: spaceB.id,
      sourceId: sourceB.id,
      context: harness.ownerB,
    });
    await harness.archive.createExportJob(
      {
        spaceId: spaceB.id,
        sourceIds: [],
        idempotencyKey: `b03b-tenant-b-${harness.suffix}`,
        exportScope: 'space',
      },
      harness.ownerB,
    );

    const listedA = await harness.catalog.listSpaces({}, harness.ownerA);
    const listedB = await harness.catalog.listSpaces({}, harness.ownerB);
    expect(listedA.items.map((entry) => entry.id)).toEqual([spaceA.id]);
    expect(listedB.items.map((entry) => entry.id)).toEqual([spaceB.id]);

    const jobsA = await harness.archive.list({}, harness.ownerA);
    const jobsB = await harness.archive.list({}, harness.ownerB);
    expect(jobsA.items.map((entry) => entry.jobId)).toEqual([String(jobA.jobId)]);
    expect(jobsB.items).toHaveLength(1);
    await expect(harness.archive.get(String(jobA.jobId), harness.ownerB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    expect(
      (await harness.objectRefs.findCleanupCandidates(100, new Date(), 'all', harness.ownerA)).map(
        (entry) => entry.blobId,
      ),
    ).toEqual([objectA.blobId]);
    expect(
      (await harness.objectRefs.findCleanupCandidates(100, new Date(), 'all', harness.ownerB)).map(
        (entry) => entry.blobId,
      ),
    ).toEqual([objectB.blobId]);
  });

  it('L1-B03-AUTH-001-A02 跨租户 aggregate count distinct 只使用当前 Workspace 条件', async () => {
    const owner = await harness.createSpace(harness.ownerA);
    await harness.createSource(owner.id, harness.ownerA);
    const foreign = await harness.createSpace(harness.ownerB);
    await harness.createSource(foreign.id, harness.ownerB);
    const models = harness.models;
    const [aggregateA, aggregateB, countA, countB, distinctA, distinctB] = await Promise.all([
      models.KnowledgeSpace.aggregate([
        { $match: { workspaceId: harness.workspaceA, deletedAt: null } },
        { $count: 'total' },
      ]),
      models.KnowledgeSpace.aggregate([
        { $match: { workspaceId: harness.workspaceB, deletedAt: null } },
        { $count: 'total' },
      ]),
      models.KnowledgeSpace.countDocuments({
        workspaceId: harness.workspaceA,
        deletedAt: null,
      }),
      models.KnowledgeSpace.countDocuments({
        workspaceId: harness.workspaceB,
        deletedAt: null,
      }),
      models.KnowledgeSpace.distinct('workspaceId', {
        workspaceId: harness.workspaceA,
        deletedAt: null,
      }),
      models.KnowledgeSpace.distinct('workspaceId', {
        workspaceId: harness.workspaceB,
        deletedAt: null,
      }),
    ]);
    expect(aggregateA).toEqual([{ total: 1 }]);
    expect(aggregateB).toEqual([{ total: 1 }]);
    expect(countA).toBe(1);
    expect(countB).toBe(1);
    expect(distinctA).toEqual([harness.workspaceA]);
    expect(distinctB).toEqual([harness.workspaceB]);
  });

  it('L1-B03-AUTH-001-S01 跨租户对象读取和拒绝请求不改变另一 Workspace 文档', async () => {
    const foreignSpace = await harness.createSpace(harness.ownerB);
    const foreignSource = await harness.createSource(foreignSpace.id, harness.ownerB);
    const foreignObject = await harness.createSourceObject({
      spaceId: foreignSpace.id,
      sourceId: foreignSource.id,
      context: harness.ownerB,
    });
    const before = await harness.models.KnowledgeSource.findOne({
      workspaceId: harness.workspaceB,
      _id: foreignSource.id,
    }).lean();
    await expect(
      harness.fileApplication.preview(foreignObject.blobId, { ttlSeconds: 60 }, harness.ownerA),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      harness.catalog.updateSource(
        foreignSource.id,
        { name: 'cross tenant mutation', version: foreignSource.version },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    const after = await harness.models.KnowledgeSource.findOne({
      workspaceId: harness.workspaceB,
      _id: foreignSource.id,
    }).lean();
    expect(after?.version).toBe(before?.version);
    expect(after?.name).toBe(before?.name);

    const local = await harness.createSpace(harness.ownerA);
    await expect(
      harness.catalog.updateSpace(
        local.id,
        { version: local.version + 1, name: 'stale local update' },
        harness.ownerA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    await expect(harness.catalog.getSpace(local.id, harness.ownerA)).resolves.toMatchObject({
      name: `B03B space ${harness.suffix}`,
      version: local.version,
    });
  });

  it('L1-B03-AUTH-001-Q01 repository aggregate 静态扫描可证明 tenant 条件', async () => {
    const files = await repositorySourceFiles();
    expect(files.length).toBeGreaterThan(0);
    const aggregateChecks = files.flatMap(({ path, content }) => {
      const calls: Array<{ path: string; line: number; tenantPredicate: boolean }> = [];
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (!/\.aggregate(?:<|\()/u.test(lines[index] ?? '')) continue;
        const window = lines
          .slice(Math.max(0, index - 120), Math.min(lines.length, index + 24))
          .join('\n');
        calls.push({
          path,
          line: index + 1,
          tenantPredicate:
            /workspaceId/u.test(window) ||
            /requireWorkspaceId/u.test(window) ||
            /workspaceFilter/u.test(window),
        });
      }
      return calls;
    });
    expect(aggregateChecks.length).toBeGreaterThan(0);
    expect(aggregateChecks.filter((entry) => !entry.tenantPredicate)).toEqual([]);
  });
});
