import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_e2e_${suffix}`;
const memberId = `mem_s6_e2e_${suffix}`;
const authToken = `kb-s6-e2e-token-${suffix}`;

let app: S4AppHarness;
let spaceId = '';
let sourceId = '';
let segmentId = '';

async function request(
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
  } = {},
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = (await response.json()) as {
    success: boolean;
    data?: unknown;
    problem?: unknown;
    error?: unknown;
  };
  return { response, payload };
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  const source = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
    method: 'POST',
    idempotencyKey: `s6-source-${suffix}`,
    body: {
      kind: 'text',
      name: `S6 Source ${suffix}`,
      searchEnabled: true,
      metadata: {},
    },
  });
  expect(source.response.status).toBe(201);
  sourceId = String((source.payload.data as { id: string }).id);
  const segment = await request(`/v1/knowledge/sources/${sourceId}/segments`, {
    method: 'POST',
    idempotencyKey: `s6-segment-${suffix}`,
    body: {
      question: 'How long does a refund take?',
      answer: 'A refund takes five business days.',
      searchEnabled: true,
      metadata: { section: 'payments' },
    },
  });
  expect(segment.response.status).toBe(201);
  segmentId = String((segment.payload.data as { id: string }).id);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('S6 Jobs and Segment E2E', () => {
  it('runs Job controls, Segment versioning, index/history/reindex and batch through real runtime', async () => {
    const created = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `s6-job-create-${suffix}`,
      body: {
        kind: 'index',
        resourceType: 'segment',
        resourceId: segmentId,
        inputSnapshot: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
        priority: 5,
      },
    });
    expect(created.response.status).toBe(202);
    const job = created.payload.data as { jobId: string; status: string; version: number };
    expect(job.status).toBe('queued');
    const paused = await request(`/v1/knowledge/jobs/${job.jobId}/pause`, {
      method: 'POST',
      idempotencyKey: `s6-job-pause-${suffix}`,
      body: { version: job.version },
    });
    expect(paused.response.status).toBe(200);
    expect((paused.payload.data as { status: string }).status).toBe('paused');
    const resumed = await request(`/v1/knowledge/jobs/${job.jobId}/resume`, {
      method: 'POST',
      idempotencyKey: `s6-job-resume-${suffix}`,
      body: { version: (paused.payload.data as { version: number }).version },
    });
    expect(resumed.response.status).toBe(200);
    const cancelled = await request(`/v1/knowledge/jobs/${job.jobId}/cancel`, {
      method: 'POST',
      idempotencyKey: `s6-job-cancel-${suffix}`,
      body: { version: (resumed.payload.data as { version: number }).version },
    });
    expect((cancelled.payload.data as { status: string }).status).toBe('cancelled');
    const stale = await request(`/v1/knowledge/jobs/${job.jobId}/retry`, {
      method: 'POST',
      idempotencyKey: `s6-job-retry-${suffix}`,
      body: { version: job.version },
    });
    expect(stale.response.status).toBe(409);

    const updated = await request(`/v1/knowledge/segments/${segmentId}`, {
      method: 'PATCH',
      idempotencyKey: `s6-segment-update-${suffix}`,
      body: {
        question: 'How quickly is a refund processed?',
        answer: 'Refunds are processed within five business days.',
        searchEnabled: true,
        version: 1,
      },
    });
    expect(updated.response.status).toBe(200);
    const updatedSegment = updated.payload.data as { version: number };
    const conflict = await request(`/v1/knowledge/segments/${segmentId}`, {
      method: 'PATCH',
      idempotencyKey: `s6-segment-conflict-${suffix}`,
      body: { question: 'stale', answer: 'stale', version: 1 },
    });
    expect(conflict.response.status).toBe(409);

    const index = await request(`/v1/knowledge/segments/${segmentId}/indexes`, {
      method: 'POST',
      idempotencyKey: `s6-index-create-${suffix}`,
      body: {
        indexId: 'default',
        type: 'default',
        text: 'Refunds are processed within five business days.',
        modelId: 'mock-embedding-1024',
        version: updatedSegment.version,
      },
    });
    expect(index.response.status).toBe(201);
    const indexedSegment = index.payload.data as { version: number; indexes: unknown[] };
    expect(indexedSegment.indexes).toHaveLength(1);

    const mismatchedIndex = await request(`/v1/knowledge/segments/${segmentId}/indexes/default`, {
      method: 'PATCH',
      idempotencyKey: `s6-index-mismatch-${suffix}`,
      body: {
        indexId: 'different',
        type: 'default',
        text: 'Mismatched index body.',
        modelId: 'mock-embedding-1024',
        version: indexedSegment.version,
      },
    });
    expect(mismatchedIndex.response.status).toBe(400);

    const indexUpdate = await request(`/v1/knowledge/segments/${segmentId}/indexes/default`, {
      method: 'PATCH',
      idempotencyKey: `s6-index-update-${suffix}`,
      body: {
        indexId: 'default',
        type: 'default',
        text: 'Updated refund indexing text.',
        modelId: 'mock-embedding-1024',
        version: indexedSegment.version,
      },
    });
    expect(indexUpdate.response.status).toBe(200);
    const updatedIndexSegment = indexUpdate.payload.data as { version: number };
    const customIndex = await request(`/v1/knowledge/segments/${segmentId}/indexes`, {
      method: 'POST',
      idempotencyKey: `s6-index-custom-${suffix}`,
      body: {
        indexId: 'custom',
        type: 'custom',
        text: 'Custom refund index text.',
        modelId: 'mock-embedding-1024',
        version: updatedIndexSegment.version,
      },
    });
    expect(customIndex.response.status).toBe(201);
    const customIndexSegment = customIndex.payload.data as { version: number };
    const indexDelete = await request(`/v1/knowledge/segments/${segmentId}/indexes/custom`, {
      method: 'DELETE',
      idempotencyKey: `s6-index-delete-${suffix}`,
      body: { version: customIndexSegment.version },
    });
    expect(indexDelete.response.status).toBe(202);

    const history = await request(`/v1/knowledge/segments/${segmentId}/history`);
    expect(history.response.status).toBe(200);
    expect((history.payload.data as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const current = await request(`/v1/knowledge/segments/${segmentId}`);
    expect(current.response.status).toBe(200);
    const currentVersion = (current.payload.data as { version: number }).version;
    const reindex = await request(`/v1/knowledge/segments/${segmentId}/reindex`, {
      method: 'POST',
      idempotencyKey: `s6-reindex-${suffix}`,
      body: { reason: 'manual', version: currentVersion },
    });
    expect(reindex.response.status).toBe(202);
    const batch = await request('/v1/knowledge/segments/batch-actions', {
      method: 'POST',
      idempotencyKey: `s6-batch-${suffix}`,
      body: {
        action: 'reindex',
        items: [{ segmentId, version: currentVersion + 1 }],
      },
    });
    expect([200, 207]).toContain(batch.response.status);
    expect((batch.payload.data as { requested: number }).requested).toBe(1);

    const spaceRebuild = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `s6-space-rebuild-${suffix}`,
      body: {
        kind: 'rebuild',
        resourceType: 'space',
        resourceId: spaceId,
        inputSnapshot: { sourceIds: [sourceId], reason: 'manual' },
      },
    });
    expect(spaceRebuild.response.status).toBe(202);
  });

  it('renders Jobs, Segments and Segment Edit at 360/768/1200 with axe and no overflow', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    for (const page of [
      `/spaces/${spaceId}/jobs`,
      `/spaces/${spaceId}/segments?sourceId=${sourceId}`,
      `/spaces/${spaceId}/segments/${segmentId}`,
    ]) {
      await verifyResponsivePage({
        baseUrl: app.baseUrl,
        path: page,
        cookie,
        screenshotPrefix: page.includes('/jobs')
          ? 's6-jobs'
          : page.endsWith(segmentId)
            ? 's6-segment-edit'
            : 's6-segments',
        resultDir: 's6-ui',
      });
    }
  }, 180_000);
});
