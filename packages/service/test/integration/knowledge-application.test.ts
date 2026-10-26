import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeApiError } from '@kb/contracts';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobRepository,
  KnowledgeTagRepository,
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
const workspaceId = `ws_app_${suffix}`;
const otherWorkspaceId = `ws_other_${suffix}`;
const memberId = `mem_owner_${suffix}`;
const otherMemberId = `mem_other_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);

const ownerContext: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-owner-${suffix}`,
  traceId,
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: false,
};

const otherMemberContext: TenantContext = {
  ...ownerContext,
  memberId: otherMemberId,
  requestId: `req-other-${suffix}`,
};

let connection: mongoose.Connection;
let application: KnowledgeApplication;
let jobs: KnowledgeJobRepository;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  context?: TenantContext;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    context: input.context ?? ownerContext,
  });
}

function expectKnowledgeError(error: unknown, code: string): asserts error is KnowledgeApiError {
  expect(error).toHaveProperty('problem.error.code', code);
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  application = new KnowledgeApplication(
    new KnowledgeCatalogRepository(connection),
    new KnowledgeTagRepository(connection),
    new KnowledgeAccessRepository(connection),
    new KnowledgeJobRepository(connection),
    undefined,
    undefined,
    undefined,
    new KnowledgeAuditRepository(connection),
  );
  jobs = new KnowledgeJobRepository(connection);
}, 60_000);

beforeEach(async () => {
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
});

afterAll(async () => {
  if (connection) {
    const models = registerKnowledgeModels(connection);
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
    }
    await connection.close();
  }
});

describe('knowledge application runtime subset', () => {
  it('creates and isolates Space, Directory, Source and Segment with workspace guards', async () => {
    const space = (
      await run({
        operationId: 'API-SPACE-CREATE',
        body: {
          kind: 'space',
          name: 'Handbook',
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      })
    ).data as { id: string; version: number };
    expect(space.id).toMatch(/^[a-f0-9]{24}$/);

    const directory = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: space.id },
        body: { name: 'Guides' },
      })
    ).data as { id: string; depth: number };
    expect(directory.depth).toBe(0);

    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: space.id },
        body: { kind: 'text', directoryId: directory.id, name: 'Getting started' },
      })
    ).data as { id: string; permissionRevision: number };

    const segment = (
      await run({
        operationId: 'API-SEGMENT-CREATE',
        params: { sourceId: source.id },
        body: { question: 'How do I start?', answer: 'Open the guide.' },
      })
    ).data as { id: string; order: number };
    expect(segment.order).toBe(0);

    const visible = (await run({ operationId: 'API-SPACE-LIST' })).data as {
      items: Array<{ id: string }>;
    };
    expect(visible.items.some((item) => item.id === space.id)).toBe(true);

    const otherSpaceRead = await run({
      operationId: 'API-SPACE-GET',
      params: { spaceId: space.id },
      context: { ...otherMemberContext, workspaceId: otherWorkspaceId },
    }).catch((error) => error);
    expectKnowledgeError(otherSpaceRead, 'KNOWLEDGE_NOT_FOUND');
  });

  it('enforces CAS and allows exactly one concurrent mutation at the same version', async () => {
    const space = (
      await run({
        operationId: 'API-SPACE-CREATE',
        body: {
          kind: 'space',
          name: 'Concurrent',
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      })
    ).data as { id: string; version: number };

    const outcomes = await Promise.allSettled([
      run({
        operationId: 'API-SPACE-UPDATE',
        params: { spaceId: space.id },
        body: { version: space.version, name: 'First update' },
      }),
      run({
        operationId: 'API-SPACE-UPDATE',
        params: { spaceId: space.id },
        body: { version: space.version, name: 'Second update' },
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expectKnowledgeError(rejected.reason, 'KNOWLEDGE_CONFLICT');
    }
  });

  it('runs the Source ACL state machine and increments permissionRevision', async () => {
    const space = (
      await run({
        operationId: 'API-SPACE-CREATE',
        body: {
          kind: 'space',
          name: 'ACL space',
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      })
    ).data as { id: string };
    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: space.id },
        body: { kind: 'text', name: 'Restricted source' },
      })
    ).data as { id: string; version: number; permissionRevision: number };
    expect(source.permissionRevision).toBe(0);

    const enabled = await run({
      operationId: 'API-PERMISSION-ENABLE',
      params: { sourceId: source.id },
      body: {
        version: source.version,
        expectedPermissionRevision: source.permissionRevision,
      },
    });
    expect((enabled.data as { permissionState: string }).permissionState).toBe('inherited');
    expect((enabled.data as { permissionRevision: number }).permissionRevision).toBe(1);

    const enabledSource = (
      await run({
        operationId: 'API-SOURCE-GET',
        params: { sourceId: source.id },
      })
    ).data as { version: number; permissionRevision: number };
    const detached = await run({
      operationId: 'API-PERMISSION-DETACH',
      params: { sourceId: source.id },
      body: {
        version: enabledSource.version,
        expectedPermissionRevision: enabledSource.permissionRevision,
      },
    });
    expect((detached.data as { permissionState: string }).permissionState).toBe('independent');
    expect((detached.data as { permissionRevision: number }).permissionRevision).toBe(2);
  });

  it('creates delete Job and Outbox facts in one Mongo transaction', async () => {
    const space = (
      await run({
        operationId: 'API-SPACE-CREATE',
        body: {
          kind: 'space',
          name: 'Delete space',
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      })
    ).data as { id: string };
    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: space.id },
        body: { kind: 'text', name: 'Delete source' },
      })
    ).data as { id: string };
    const result = (
      await run({
        operationId: 'API-SOURCE-DELETE',
        params: { sourceId: source.id },
      })
    ).data as { jobId: string };
    expect(result.jobId).toMatch(/^[a-f0-9]{24}$/);

    const models = registerKnowledgeModels(connection);
    await expect(
      models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: source.id,
        status: 'pending',
      }),
    ).resolves.toBe(1);
    await expect(
      models.KnowledgeJob.countDocuments({
        workspaceId,
        resourceId: source.id,
        kind: 'delete',
      }),
    ).resolves.toBe(1);
  });

  it('uses lease + fencing tokens and refuses stale worker commits', async () => {
    const models = registerKnowledgeModels(connection);
    const jobId = new mongoose.Types.ObjectId();
    const spaceId = new mongoose.Types.ObjectId();
    await models.KnowledgeJob.create({
      _id: jobId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      kind: 'parse',
      resourceType: 'source',
      resourceId: String(new mongoose.Types.ObjectId()),
      status: 'queued',
      priority: 0,
      idempotencyKey: `job-${suffix}`,
      inputSnapshot: {},
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      attempts: 0,
      maxAttempts: 3,
      attemptEpoch: 0,
      fencingToken: 'unassigned',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: new Date(),
      cancelRequestedAt: null,
      pausedAt: null,
      error: null,
      result: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const claimed = await jobs.claim({ workerId: 'worker-a' }, ownerContext);
    expect(claimed?.status).toBe('leased');
    const raw = await models.KnowledgeJob.findById(jobId);
    expect(raw?.fencingToken).not.toBe('');
    await jobs.start(
      {
        jobId: String(jobId),
        workerId: 'worker-a',
        attemptEpoch: raw!.attemptEpoch,
        fencingToken: raw!.fencingToken,
        expectedVersion: raw!.version,
      },
      ownerContext,
    );
    const newest = await models.KnowledgeJob.findById(jobId);
    await expect(
      jobs.commit(
        {
          jobId: String(jobId),
          workerId: 'worker-a',
          attemptEpoch: newest!.attemptEpoch - 1,
          fencingToken: 'stale',
          expectedVersion: newest!.version,
          result: {},
        },
        ownerContext,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_JOB_FAILED' } },
    });
  });
});
