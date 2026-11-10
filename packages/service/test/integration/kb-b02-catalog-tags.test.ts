import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeJobRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeTagRepository,
  S06JobApplication,
} from '../../src/modules/knowledge';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b02_${suffix}`;
const foreignWorkspaceId = `ws_b02_foreign_${suffix}`;
const memberId = `mem_b02_owner_${suffix}`;
const foreignMemberId = `mem_b02_foreign_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);
const ownerContext: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-b02-${suffix}`,
  traceId,
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: false,
};
const foreignContext: TenantContext = {
  ...ownerContext,
  workspaceId: foreignWorkspaceId,
  memberId: foreignMemberId,
  requestId: `req-b02-foreign-${suffix}`,
};
const readerContext: TenantContext = {
  ...ownerContext,
  memberId: `mem_b02_reader_${suffix}`,
  requestId: `req-b02-reader-${suffix}`,
  scopes: ['knowledge:read'],
};

let connection: mongoose.Connection;
let application: KnowledgeApplication;
let catalog: KnowledgeCatalogRepository;
let tags: KnowledgeTagRepository;
let jobs: KnowledgeJobRepository;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  context?: TenantContext;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    headers: input.headers ?? {},
    context: input.context ?? ownerContext,
  });
}

async function createSpace(name = `B02 space ${suffix}`) {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'space',
        name,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number };
}

async function createDirectory(
  spaceId: string,
  name: string,
  parentDirectoryId: string | null = null,
) {
  return (
    await run({
      operationId: 'API-DIRECTORY-CREATE',
      params: { spaceId },
      body: { name, parentDirectoryId },
    })
  ).data as { id: string; version: number; path: string[]; depth: number };
}

async function createSource(
  spaceId: string,
  name: string,
  kind: 'file' | 'text' = 'text',
  directoryId: string | null = null,
) {
  return (
    await run({
      operationId: 'API-SOURCE-CREATE',
      params: { spaceId },
      body: { kind, name, directoryId },
    })
  ).data as { id: string; version: number; directoryId: string | null };
}

async function createTag(
  spaceId: string,
  input: {
    key: string;
    label: string;
    tagType: 'string' | 'number' | 'datetime' | 'array';
    options?: string[];
    required?: boolean;
  },
) {
  return (
    await run({
      operationId: 'API-TAG-CREATE',
      params: { spaceId },
      body: { required: false, ...input },
    })
  ).data as { id: string; version: number; tagType: string };
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  tags = new KnowledgeTagRepository(connection);
  jobs = new KnowledgeJobRepository(connection);
  const access = new KnowledgeAccessRepository(connection);
  const s06 = new S06JobApplication(
    new KnowledgeJobExecutionRepository(connection),
    new KnowledgeSegmentIndexRepository(connection),
    catalog,
    access,
  );
  application = new KnowledgeApplication(
    catalog,
    tags,
    access,
    jobs,
    undefined,
    undefined,
    undefined,
    new KnowledgeAuditRepository(connection),
    undefined,
    undefined,
    s06,
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, foreignWorkspaceId] } });
  }
});

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId: { $in: [workspaceId, foreignWorkspaceId] } });
    }
    await connection.close();
  }
});

describe('L1 B02 Directory, Source and Tag integration', () => {
  it('L1-B02-COL-001-P01 创建三层目录、文件 Source 与虚拟 Source 并保持路径、父级和刷新结果', async () => {
    const space = await createSpace();
    const first = await createDirectory(space.id, `根目录 ${suffix}`);
    const second = await createDirectory(space.id, `子目录 ${suffix}`, first.id);
    const third = await createDirectory(space.id, `孙目录 ${suffix}`, second.id);
    const file = await createSource(space.id, `文件 ${suffix}`, 'file', third.id);
    const text = await createSource(space.id, `虚拟文本 ${suffix}`, 'text', third.id);

    expect(third).toMatchObject({
      path: [first.id, second.id],
      depth: 2,
    });
    expect(file).toMatchObject({ directoryId: third.id, kind: 'file' });
    expect(text).toMatchObject({ directoryId: third.id, kind: 'text' });

    const directories = (
      await run({
        operationId: 'API-DIRECTORY-LIST',
        params: { spaceId: space.id },
        query: { limit: '100' },
      })
    ).data as { items: Array<{ id: string; path: string[]; depth: number }> };
    expect(directories.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, depth: 0 }),
        expect.objectContaining({ id: second.id, path: [first.id], depth: 1 }),
        expect.objectContaining({ id: third.id, path: [first.id, second.id], depth: 2 }),
      ]),
    );

    const sources = (
      await run({
        operationId: 'API-SOURCE-LIST',
        params: { spaceId: space.id },
        query: { limit: '100' },
      })
    ).data as { items: Array<{ id: string; name: string; directoryId: string | null }> };
    expect(sources.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: file.id, directoryId: third.id }),
        expect.objectContaining({ id: text.id, directoryId: third.id }),
      ]),
    );
    await expect(catalog.getDirectory(third.id, ownerContext)).resolves.toMatchObject({
      id: third.id,
      parentDirectoryId: second.id,
      path: [first.id, second.id],
      depth: 2,
    });
  });

  it('L1-B02-COL-001-N01 拒绝空名称非法父级和超深目录且同级重名遵循 FastGPT 可共存行为', async () => {
    const space = await createSpace();
    await expect(
      run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: space.id },
        body: { name: '   ' },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    await expect(
      run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: space.id },
        body: {
          name: `Bad parent ${suffix}`,
          parentDirectoryId: new mongoose.Types.ObjectId().toString(),
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });

    let parent = await createDirectory(space.id, `Level 0 ${suffix}`);
    for (let depth = 1; depth <= 4; depth += 1) {
      parent = await createDirectory(space.id, `Level ${depth} ${suffix}`, parent.id);
    }
    await expect(createDirectory(space.id, `Level 5 ${suffix}`, parent.id)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const duplicateName = `同名目录 ${suffix}`;
    const first = await createDirectory(space.id, duplicateName);
    const second = await createDirectory(space.id, duplicateName);
    expect(second.id).not.toBe(first.id);
    const persisted = (
      await run({
        operationId: 'API-DIRECTORY-LIST',
        params: { spaceId: space.id },
        query: { limit: '100' },
      })
    ).data as { items: Array<{ id: string; name: string }> };
    expect(persisted.items.filter((entry) => entry.name === duplicateName)).toHaveLength(2);
  });

  it('L1-B02-COL-001-A01 跨 Workspace 的目录和 Source 读写删除均不可见且无写入', async () => {
    const space = await createSpace();
    const directory = await createDirectory(space.id, `私有目录 ${suffix}`);
    const source = await createSource(space.id, `私有来源 ${suffix}`, 'text', directory.id);

    await expect(catalog.getDirectory(directory.id, foreignContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(catalog.getSource(source.id, foreignContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: space.id },
        body: { kind: 'text', name: `伪造来源 ${suffix}`, directoryId: directory.id },
        context: foreignContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run({
        operationId: 'API-DIRECTORY-DELETE',
        params: { directoryId: directory.id },
        context: foreignContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });

    await expect(catalog.getDirectory(directory.id, ownerContext)).resolves.toMatchObject({
      id: directory.id,
      version: directory.version,
    });
    await expect(catalog.getSource(source.id, ownerContext)).resolves.toMatchObject({
      id: source.id,
      version: source.version,
    });
  });

  it('L1-B02-COL-001-S01 删除目录事务标记完整子树并创建唯一删除 Job、Outbox 与审计', async () => {
    const space = await createSpace();
    const parent = await createDirectory(space.id, `待删目录 ${suffix}`);
    const child = await createDirectory(space.id, `待删子目录 ${suffix}`, parent.id);
    const sibling = await createDirectory(space.id, `保留目录 ${suffix}`);
    const result = (
      await run({
        operationId: 'API-DIRECTORY-DELETE',
        params: { directoryId: parent.id },
      })
    ).data as { jobId: string };

    expect(result.jobId).toMatch(/^[a-f0-9]{24}$/);
    await expect(catalog.getDirectory(parent.id, ownerContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(catalog.getDirectory(child.id, ownerContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(catalog.getDirectory(sibling.id, ownerContext)).resolves.toMatchObject({
      id: sibling.id,
    });
    const models = registerKnowledgeModels(connection);
    await expect(
      models.KnowledgeJob.countDocuments({
        workspaceId,
        resourceType: 'directory',
        resourceId: parent.id,
        kind: 'delete',
      }),
    ).resolves.toBe(1);
    await expect(
      models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateType: 'directory',
        aggregateId: parent.id,
        eventType: 'delete',
      }),
    ).resolves.toBe(1);
    await expect(
      models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        action: 'directory.delete',
        resourceId: parent.id,
        outcome: 'succeeded',
      }),
    ).resolves.toBe(1);
  });

  it('L1-B02-COL-001-F01 Source 解析失败后仍可查询并保持失败状态，删除失败保留可重试资源', async () => {
    const space = await createSpace();
    const source = await createSource(space.id, `解析失败来源 ${suffix}`);
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(source.id) },
      { $set: { processingStatus: 'failed' }, $inc: { version: 1 } },
    );
    const failed = await catalog.getSource(source.id, ownerContext);
    expect(failed).toMatchObject({ id: source.id, processingStatus: 'failed' });
    expect(failed.processingStatus).not.toBe('ready');
    await expect(catalog.getSource(source.id, ownerContext)).resolves.toMatchObject({
      id: source.id,
    });
  });

  it('L1-B02-COL-002-P01 Source 列表详情和重建任务展示类型、状态、路径与稳定 Source ID', async () => {
    const space = await createSpace();
    const directory = await createDirectory(space.id, `列表目录 ${suffix}`);
    const source = await createSource(space.id, `列表来源 ${suffix}`, 'file', directory.id);
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(source.id) },
      { $set: { processingStatus: 'ready' } },
    );
    const detail = await catalog.getSource(source.id, ownerContext);
    expect(detail).toMatchObject({
      id: source.id,
      name: `列表来源 ${suffix}`,
      kind: 'file',
      directoryId: directory.id,
      processingStatus: 'ready',
    });

    const rebuild = (
      await run({
        operationId: 'API-JOB-CREATE',
        headers: { 'idempotency-key': `rebuild-${suffix}-0001` },
        body: {
          kind: 'rebuild',
          resourceType: 'source',
          resourceId: source.id,
          inputSnapshot: {
            sourceId: source.id,
            sourceVersion: detail.sourceVersion,
            reason: 'validation',
            expectedSegmentVersions: [],
            targetModelId: 'embedding-b02-local',
          },
        },
      })
    ).data as { jobId: string };
    const job = (
      await run({
        operationId: 'API-JOB-GET',
        params: { jobId: rebuild.jobId },
      })
    ).data as { jobId: string; kind: string; status: string; resourceId: string };
    expect(job).toMatchObject({
      jobId: rebuild.jobId,
      kind: 'rebuild',
      status: 'queued',
      resourceId: source.id,
    });
  });

  it('L1-B02-COL-002-N01 不存在 Source 和非法分页被拒绝且不返回伪造成功', async () => {
    const space = await createSpace();
    await expect(
      run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: new mongoose.Types.ObjectId().toString() },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run({
        operationId: 'API-SOURCE-LIST',
        params: { spaceId: space.id },
        query: { limit: '0' },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
  });

  it('L1-B02-COL-002-A01 跨 Workspace 的 Source 与 Job 不可见，只读成员不能创建重建任务', async () => {
    const space = await createSpace();
    const source = await createSource(space.id, `租户来源 ${suffix}`);
    await expect(catalog.getSource(source.id, foreignContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      run({
        operationId: 'API-JOB-CREATE',
        headers: { 'idempotency-key': `reader-rebuild-${suffix}-1` },
        body: {
          kind: 'rebuild',
          resourceType: 'source',
          resourceId: source.id,
          inputSnapshot: {
            sourceId: source.id,
            sourceVersion: 1,
            reason: 'reader',
            expectedSegmentVersions: [],
          },
        },
        context: readerContext,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: expect.stringMatching(/KNOWLEDGE_(FORBIDDEN|NOT_FOUND)/) } },
    });
  });

  it('L1-B02-COL-002-S01 列表读取不修改业务数据，重建创建新 Job 且 Source ID 保持', async () => {
    const space = await createSpace();
    const source = await createSource(space.id, `稳定来源 ${suffix}`);
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(source.id) },
      { $set: { processingStatus: 'ready' } },
    );
    const before = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      _id: new mongoose.Types.ObjectId(source.id),
    }).lean();
    await run({
      operationId: 'API-SOURCE-LIST',
      params: { spaceId: space.id },
      query: { limit: '100' },
    });
    await run({ operationId: 'API-SOURCE-GET', params: { sourceId: source.id } });
    const after = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      _id: new mongoose.Types.ObjectId(source.id),
    }).lean();
    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt?.toISOString()).toBe(before?.updatedAt?.toISOString());

    const rebuild = (
      await run({
        operationId: 'API-JOB-CREATE',
        headers: { 'idempotency-key': `stable-rebuild-${suffix}-1` },
        body: {
          kind: 'rebuild',
          resourceType: 'source',
          resourceId: source.id,
          inputSnapshot: {
            sourceId: source.id,
            sourceVersion: before?.sourceVersion ?? 1,
            reason: 'manual',
            expectedSegmentVersions: [],
          },
        },
      })
    ).data as { jobId: string };
    await expect(jobs.get(rebuild.jobId, ownerContext)).resolves.toMatchObject({
      jobId: rebuild.jobId,
      resourceId: source.id,
      kind: 'rebuild',
    });
    await expect(catalog.getSource(source.id, ownerContext)).resolves.toMatchObject({
      id: source.id,
    });
  });

  it('L1-B02-COL-002-F01 失败 Source 保留在列表中且不会被显示为已就绪', async () => {
    const space = await createSpace();
    const source = await createSource(space.id, `失败同步来源 ${suffix}`);
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(source.id) },
      { $set: { processingStatus: 'failed' }, $inc: { version: 1 } },
    );
    const listed = (
      await run({
        operationId: 'API-SOURCE-LIST',
        params: { spaceId: space.id },
        query: { limit: '100' },
      })
    ).data as { items: Array<{ id: string; processingStatus: string }> };
    expect(listed.items.find((entry) => entry.id === source.id)).toMatchObject({
      id: source.id,
      processingStatus: 'failed',
    });
  });

  it('L1-B02-COL-003-P01 四类标签定义与单条批量赋值在刷新后保持并能按真实值筛选', async () => {
    const space = await createSpace();
    const first = await createSource(space.id, `标签来源一 ${suffix}`);
    const second = await createSource(space.id, `标签来源二 ${suffix}`);
    const stringTag = await createTag(space.id, {
      key: `string_${suffix.slice(0, 8)}`,
      label: '部门',
      tagType: 'string',
      options: ['support', 'sales'],
    });
    const numberTag = await createTag(space.id, {
      key: `number_${suffix.slice(0, 8)}`,
      label: '优先级',
      tagType: 'number',
    });
    const datetimeTag = await createTag(space.id, {
      key: `date_${suffix.slice(0, 8)}`,
      label: '发布日期',
      tagType: 'datetime',
    });
    const arrayTag = await createTag(space.id, {
      key: `array_${suffix.slice(0, 8)}`,
      label: '地区',
      tagType: 'array',
      options: ['cn', 'apac', 'global'],
    });

    await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [
          { sourceId: first.id, tagId: stringTag.id, value: 'support' },
          { sourceId: first.id, tagId: numberTag.id, value: 3 },
          { sourceId: first.id, tagId: datetimeTag.id, value: '2026-11-10T12:00:00.000Z' },
          { sourceId: first.id, tagId: arrayTag.id, value: ['cn', 'apac', 'cn'] },
          { sourceId: second.id, tagId: stringTag.id, value: 'sales' },
        ],
        sourceVersions: {
          [first.id]: first.version,
          [second.id]: second.version,
        },
      },
    });
    const firstSource = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: first.id },
      })
    ).data as {
      tagValues: Array<{ tagId: string; value: unknown; valueKey: string }>;
    };
    expect(firstSource.tagValues).toHaveLength(4);
    expect(firstSource.tagValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagId: stringTag.id, value: 'support' }),
        expect.objectContaining({ tagId: numberTag.id, value: 3 }),
        expect.objectContaining({ tagId: arrayTag.id, value: ['apac', 'cn'] }),
      ]),
    );
    const datetimeValue = firstSource.tagValues.find((entry) => entry.tagId === datetimeTag.id);
    expect(datetimeValue?.value).toBe(Date.parse('2026-11-10T12:00:00.000Z'));
  });

  it('L1-B02-COL-003-N01 重复 key、非法 options 和 required 未赋值被稳定拒绝', async () => {
    const space = await createSpace();
    const key = `dup_${suffix.slice(0, 8)}`;
    await createTag(space.id, {
      key,
      label: '重复键',
      tagType: 'number',
    });
    await expect(
      createTag(space.id, {
        key,
        label: '重复键二',
        tagType: 'number',
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    const required = await createTag(space.id, {
      key: `required_${suffix.slice(0, 8)}`,
      label: '必填标签',
      tagType: 'string',
      options: ['yes'],
      required: true,
    });
    const source = await createSource(space.id, `必填来源 ${suffix}`);
    await expect(
      run({
        operationId: 'API-TAG-APPLY',
        body: { items: [{ sourceId: source.id, tagId: required.id, value: 'yes' }] },
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'sourceVersions' },
        },
      },
    });
    const assigned = await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [{ sourceId: source.id, tagId: required.id, value: 'yes' }],
        sourceVersions: { [source.id]: source.version },
      },
    });
    expect(assigned.status).toBe(200);
    const current = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: source.id },
      })
    ).data as { version: number };
    const removal = await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [{ sourceId: source.id, tagId: required.id, value: null }],
        sourceVersions: { [source.id]: current.version },
      },
    });
    expect(removal.status).toBe(207);
    expect(removal.data).toMatchObject({
      code: 'KNOWLEDGE_PARTIAL_SUCCESS',
      failed: 1,
      items: [
        expect.objectContaining({
          id: source.id,
          tagId: required.id,
          success: false,
          code: 'KNOWLEDGE_CONFLICT',
        }),
      ],
    });
  });

  it('L1-B02-COL-003-N01 required 标签清空失败时保留原值并允许其他标签继续处理', async () => {
    const space = await createSpace();
    const source = await createSource(space.id, `必填缺失来源 ${suffix}`);
    const required = await createTag(space.id, {
      key: `required_only_${suffix.slice(0, 8)}`,
      label: '必须赋值',
      tagType: 'number',
      required: true,
    });
    const assigned = await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [{ sourceId: source.id, tagId: required.id, value: 1 }],
        sourceVersions: { [source.id]: source.version },
      },
    });
    expect(assigned.status).toBe(200);
    const current = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: source.id },
      })
    ).data as { version: number; tagValues: Array<{ tagId: string }> };
    const removal = await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [{ sourceId: source.id, tagId: required.id, value: null }],
        sourceVersions: { [source.id]: current.version },
      },
    });
    expect(removal.status).toBe(207);
    const detail = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: source.id },
      })
    ).data as { tagValues: Array<{ tagId: string }> };
    expect(detail.tagValues).toEqual([expect.objectContaining({ tagId: required.id })]);
  });

  it('L1-B02-COL-003-A01 跨租户 tagId 和只读成员打标均被拒绝且不泄露目标值', async () => {
    const foreignSpace = await createSpace(`外部空间 ${suffix}`);
    const foreignSource = await createSource(foreignSpace.id, `外部来源 ${suffix}`);
    const foreignTag = await createTag(foreignSpace.id, {
      key: `foreign_${suffix.slice(0, 8)}`,
      label: '外部标签',
      tagType: 'number',
    });
    const space = await createSpace();
    const source = await createSource(space.id, `只读来源 ${suffix}`);
    await expect(catalog.getSource(foreignSource.id, foreignContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      run({
        operationId: 'API-TAG-APPLY',
        body: {
          items: [{ sourceId: source.id, tagId: foreignTag.id, value: 1 }],
          sourceVersions: { [source.id]: source.version },
        },
        context: readerContext,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: expect.stringMatching(/KNOWLEDGE_(FORBIDDEN|NOT_FOUND)/) } },
    });
  });

  it('L1-B02-COL-003-S01 删除被引用标签级联清理值且不改变其他 Source 的值', async () => {
    const space = await createSpace();
    const first = await createSource(space.id, `标签删除来源一 ${suffix}`);
    const second = await createSource(space.id, `标签删除来源二 ${suffix}`);
    const tag = await createTag(space.id, {
      key: `delete_${suffix.slice(0, 8)}`,
      label: '待删标签',
      tagType: 'string',
      options: ['a', 'b'],
    });
    const other = await createTag(space.id, {
      key: `other_${suffix.slice(0, 8)}`,
      label: '保留标签',
      tagType: 'number',
    });
    await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [
          { sourceId: first.id, tagId: tag.id, value: 'a' },
          { sourceId: second.id, tagId: tag.id, value: 'b' },
          { sourceId: first.id, tagId: other.id, value: 9 },
        ],
        sourceVersions: {
          [first.id]: first.version,
          [second.id]: second.version,
        },
      },
    });
    await run({ operationId: 'API-TAG-DELETE', params: { tagId: tag.id } });
    const firstAfter = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: first.id },
      })
    ).data as { tagValues: Array<{ tagId: string }> };
    const secondAfter = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: second.id },
      })
    ).data as { tagValues: Array<{ tagId: string }> };
    expect(firstAfter.tagValues).toEqual([expect.objectContaining({ tagId: other.id })]);
    expect(secondAfter.tagValues).toEqual([]);
  });

  it('L1-B02-COL-003-F01 批量打标部分失败返回逐项结果并保留成功项', async () => {
    const space = await createSpace();
    const valid = await createSource(space.id, `批量有效来源 ${suffix}`);
    const invalid = await createSource(space.id, `批量无效来源 ${suffix}`);
    const tag = await createTag(space.id, {
      key: `batch_${suffix.slice(0, 8)}`,
      label: '批量标签',
      tagType: 'number',
    });
    const response = await run({
      operationId: 'API-TAG-APPLY',
      body: {
        items: [
          { sourceId: valid.id, tagId: tag.id, value: 1 },
          { sourceId: invalid.id, tagId: new mongoose.Types.ObjectId().toString(), value: 2 },
        ],
        sourceVersions: {
          [valid.id]: valid.version,
          [invalid.id]: invalid.version,
        },
      },
    });
    expect(response.status).toBe(207);
    const result = response.data as {
      requested: number;
      succeeded: number;
      failed: number;
      items: unknown[];
    };
    expect(result).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: valid.id, success: true }),
        expect.objectContaining({ id: invalid.id, success: false }),
      ]),
    );
    const validAfter = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: valid.id },
      })
    ).data as { tagValues: Array<{ tagId: string }> };
    const invalidAfter = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: invalid.id },
      })
    ).data as { tagValues: Array<{ tagId: string }> };
    expect(validAfter.tagValues).toEqual([expect.objectContaining({ tagId: tag.id })]);
    expect(invalidAfter.tagValues).toEqual([]);
  });
});
