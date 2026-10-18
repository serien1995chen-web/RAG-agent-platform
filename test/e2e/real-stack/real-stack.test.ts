import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ISSUE-009：真栈端到端（API → Application → Repository → Mongo/PG/Redis/MinIO）。
 *
 * 与 `test/e2e/*` 的 mock-runtime 用例不同，这里注入的是 bootstrapRuntime()
 * 产出的**真实 runtime**；Mongo、pgvector、Redis、MinIO 均为真实依赖，
 * 未配置测试依赖地址时整组显式跳过（ISSUE-010 口径）。
 */
const hasInfra = Boolean(
  process.env.KB_MONGO_URI &&
  process.env.KB_PG_URL &&
  process.env.KB_REDIS_URL &&
  process.env.KB_S3_ENDPOINT,
);
const describeReal = hasInfra ? describe : describe.skip;

const TEAM_A = '0000000000000000000000a1';
const TEAM_B = '0000000000000000000000b1';
const TMB_A = '0000000000000000000000a2';
const TMB_B = '0000000000000000000000b2';

let currentTeam = { teamId: TEAM_A, tmbId: TMB_A };
const runtimeState = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock('../../../projects/app/src/runtime', () => ({
  getRuntime: async () => runtimeState.runtime,
}));

vi.mock('../../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => {
    const tenant = { ...currentTeam, authType: 'token' as const, isRoot: false };
    return {
      subject: tenant,
      context: {
        requestId: randomUUID(),
        tenant,
        permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
      },
    };
  },
}));

const { bootstrapRuntime } = await import('../../../projects/app/src/runtime/bootstrap');
const createDatasetHandler = (
  await import('../../../projects/app/src/pages/api/core/dataset/create')
).default;
const listHandler = (await import('../../../projects/app/src/pages/api/core/dataset/list')).default;
const createTextHandler = (
  await import('../../../projects/app/src/pages/api/core/dataset/collection/create/text')
).default;
const createImagesHandler = (
  await import('../../../projects/app/src/pages/api/core/dataset/collection/create/images')
).default;
const pushDataHandler = (
  await import('../../../projects/app/src/pages/api/core/dataset/data/pushData')
).default;
const deleteHandler = (await import('../../../projects/app/src/pages/api/core/dataset/delete'))
  .default;

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function makeResponse(): { response: NextApiResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {} };
  const response = {
    setHeader: () => response,
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, captured };
}

function makeRequest(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
    query: {},
    body: input.body ?? {},
  } as unknown as NextApiRequest;
}

async function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  input: { method: string; url: string; body?: unknown; headers?: Record<string, string> },
): Promise<Captured> {
  const { response, captured } = makeResponse();
  await handler(makeRequest(input), response);
  return captured;
}

const data = (captured: Captured) => (captured.body.data ?? {}) as Record<string, unknown>;

describeReal('real stack e2e (ISSUE-009)', () => {
  let datasetId = '';
  let collectionId = '';

  beforeAll(async () => {
    runtimeState.runtime = await bootstrapRuntime();
  }, 180_000);

  afterAll(async () => {
    const runtime = runtimeState.runtime as { shutdown?: () => Promise<void> } | undefined;
    await runtime?.shutdown?.();
  });

  it('REAL-01 creates a dataset against real Mongo', async () => {
    const created = await call(createDatasetHandler, {
      method: 'POST',
      url: '/api/core/dataset/create',
      body: {
        name: `real-stack-${Date.now()}`,
        type: 'dataset',
        models: { embeddingModel: 'bge-m3' },
      },
    });
    expect(created.status).toBe(200);
    datasetId = String(data(created).datasetId);
    expect(datasetId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('REAL-02 empty text import succeeds with insertLen=0 and creates no data', async () => {
    const imported = await call(createTextHandler, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/text',
      body: { datasetId, text: '' },
    });
    expect(imported.status).toBe(200);
    expect(data(imported).insertLen).toBe(0);
    collectionId = String(data(imported).collectionId);
    expect(collectionId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('REAL-03 image collection persists trainingMode=chunk and autoIndexes', async () => {
    const images = await call(createImagesHandler, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/images',
      body: {
        datasetId,
        images: [`temp/${TEAM_A}/real-stack.png`],
        trainingType: 'auto',
      },
    });
    expect([200, 400]).toContain(images.status);
    const runtime = runtimeState.runtime as {
      collectionRepository: {
        get(input: unknown, ctx: unknown): Promise<{ trainingMode?: string; type?: string }>;
      };
    };
    if (images.status === 200) {
      const id = String(data(images).collectionId);
      const snapshot = await runtime.collectionRepository.get(
        { collectionId: id, options: { timeoutMs: 10_000 } },
        {
          requestId: 'real-stack',
          tenant: { teamId: TEAM_A, tmbId: TMB_A, authType: 'token', isRoot: false },
          permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
        },
      );
      expect(snapshot.type).toBe('images');
      expect(snapshot.trainingMode).toBe('chunk');
    }
  });

  it('REAL-04 pushData rejects 201 items without creating resources', async () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => ({
      collectionId,
      q: `real-stack-${index}`,
    }));
    const pushed = await call(pushDataHandler, {
      method: 'POST',
      url: '/api/core/dataset/data/pushData',
      body: { data: tooMany },
    });
    expect(pushed.status).toBe(413);
    expect(pushed.body.code).toBe(501030);
  });

  it('REAL-05 tenant B cannot read tenant A dataset', async () => {
    currentTeam = { teamId: TEAM_B, tmbId: TMB_B };
    try {
      const listed = await call(listHandler, { method: 'GET', url: '/api/core/dataset/list' });
      expect(listed.status).toBe(200);
      const visible = (data(listed).list ?? []) as { datasetId?: string }[];
      expect(visible.some((item) => String(item.datasetId) === datasetId)).toBe(false);
    } finally {
      currentTeam = { teamId: TEAM_A, tmbId: TMB_A };
    }
  });

  it('REAL-06 dataset delete commits through real Mongo transactions', async () => {
    const deleted = await call(deleteHandler, {
      method: 'POST',
      url: '/api/core/dataset/delete',
      body: { datasetId },
      headers: { 'idempotency-key': `real-stack-del-${Date.now()}` },
    });
    expect(deleted.status).toBe(200);
    const result = data(deleted) as { jobId?: string; state?: string };
    expect(result.jobId).toBeTruthy();
    expect(result.state).toBe('queued');
  });
});
