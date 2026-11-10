import { randomUUID } from 'node:crypto';
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
} from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b02_c_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b02_c_${suffix}`,
  requestId: `req-b02-c-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: false,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let tags: KnowledgeTagRepository;
let application: KnowledgeApplication;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    headers: input.headers ?? {},
    context,
  });
}

async function space() {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'space',
        name: `B02 concurrency ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number };
}

async function directory(spaceId: string) {
  return (
    await run({
      operationId: 'API-DIRECTORY-CREATE',
      params: { spaceId },
      body: { name: `并发目录 ${suffix}` },
    })
  ).data as { id: string; version: number };
}

async function source(spaceId: string) {
  return (
    await run({
      operationId: 'API-SOURCE-CREATE',
      params: { spaceId },
      body: { kind: 'text', name: `并发来源 ${suffix}` },
    })
  ).data as { id: string; version: number };
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  tags = new KnowledgeTagRepository(connection);
  const access = new KnowledgeAccessRepository(connection);
  const jobExecution = new KnowledgeJobExecutionRepository(connection);
  const s06 = new S06JobApplication(
    jobExecution,
    new KnowledgeSegmentIndexRepository(connection),
    catalog,
    access,
  );
  application = new KnowledgeApplication(
    catalog,
    tags,
    access,
    new KnowledgeJobRepository(connection),
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
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('L1 B02 catalog and tag concurrency', () => {
  it('L1-B02-COL-001-C01 同版本目录更新只有一个提交且重试不产生重复子资源', async () => {
    const targetSpace = await space();
    const target = await directory(targetSpace.id);
    const outcomes = await Promise.allSettled([
      run({
        operationId: 'API-DIRECTORY-UPDATE',
        params: { directoryId: target.id },
        body: { version: target.version, name: `并发 A ${suffix}` },
      }),
      run({
        operationId: 'API-DIRECTORY-UPDATE',
        params: { directoryId: target.id },
        body: { version: target.version, name: `并发 B ${suffix}` },
      }),
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const persisted = await catalog.getDirectory(target.id, context);
    expect(persisted.version).toBe(target.version + 1);
    expect([`并发 A ${suffix}`, `并发 B ${suffix}`]).toContain(persisted.name);
  });

  it('L1-B02-COL-002-C01 同 Source 并发重建只产生一个活动任务或明确冲突', async () => {
    const targetSpace = await space();
    const target = await source(targetSpace.id);
    await connection.models.KnowledgeSource.updateOne(
      {
        workspaceId,
        _id: target.id,
      },
      { $set: { processingStatus: 'ready' } },
    );
    const request = () =>
      run({
        operationId: 'API-JOB-CREATE',
        headers: { 'idempotency-key': `same-rebuild-${suffix}` },
        body: {
          kind: 'rebuild',
          resourceType: 'source',
          resourceId: target.id,
          inputSnapshot: {
            sourceId: target.id,
            sourceVersion: 1,
            reason: 'concurrency',
            expectedSegmentVersions: [],
          },
        },
      });
    const outcomes = await Promise.allSettled([request(), request()]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
      });
    }
    await expect(
      connection.models.KnowledgeJob.countDocuments({
        workspaceId,
        resourceId: target.id,
        kind: 'rebuild',
        status: { $in: ['queued', 'leased', 'running', 'retry_wait', 'paused'] },
      }),
    ).resolves.toBe(1);
  });

  it('L1-B02-COL-003-C01 同 Source 并发覆盖使用版本确定结果，数组重试不重复元素', async () => {
    const targetSpace = await space();
    const target = await source(targetSpace.id);
    const tag = (
      await run({
        operationId: 'API-TAG-CREATE',
        params: { spaceId: targetSpace.id },
        body: {
          key: `array_${suffix.slice(0, 8)}`,
          label: '并发数组',
          tagType: 'array',
          required: false,
          options: ['a', 'b'],
        },
      })
    ).data as { id: string };
    const apply = (value: string[], sourceVersion: number) =>
      run({
        operationId: 'API-TAG-APPLY',
        body: {
          items: [{ sourceId: target.id, tagId: tag.id, value }],
          sourceVersions: { [target.id]: sourceVersion },
        },
      });
    const outcomes = await Promise.all([
      apply(['a'], target.version),
      apply(['b'], target.version),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 207]);
    const conflicts = outcomes.flatMap((outcome) =>
      (outcome.data as { items?: Array<{ success: boolean; code?: string }> }).items?.filter(
        (item) => !item.success && item.code === 'KNOWLEDGE_CONFLICT',
      ),
    );
    expect(conflicts).toHaveLength(1);
    const current = await catalog.getSource(target.id, context);
    expect(current.version).toBe(target.version + 1);
    const retried = await apply(['a', 'a'], current.version);
    expect(retried.status).toBe(200);
    const detail = await catalog.getSource(target.id, context);
    expect(detail.tagValues).toEqual([expect.objectContaining({ tagId: tag.id, value: ['a'] })]);
  });
});
