import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiRequest,
  cleanupWorkspaceObjects,
  createApiKey,
  createSourceAndSegment,
  createSpace,
  openConnections,
  partialProvider,
  redact,
  seedIndexedSegment,
  setEmbeddingBinding,
  spawnConsumer,
  startB18App,
  suffix as uniqueSuffix,
  writeJson,
  type B18AppHarness,
  type ConsumerJob,
} from '../fixtures/b18-b/support';
import {
  registerKnowledgeModels,
  type KnowledgeConnections,
  type TenantContext,
} from '../../packages/service/src';
import type { SearchApiResponse } from '@kb/contracts';

const root = resolve(import.meta.dirname, '../..');
const runId = process.env.B18_RUN_ID?.trim() || `e2e-${Date.now()}`;
const evidenceDir = join(root, 'test-results', 'b18-b', runId);
const suffixA = uniqueSuffix('down_a');
const suffixB = uniqueSuffix('down_b');
const workspaceA = `ws_${suffixA}`;
const workspaceB = `ws_${suffixB}`;
const memberA = `mem_${suffixA}`;
const memberB = `mem_${suffixB}`;
const tokenA = `b18b-auth-a-${suffixA}`;
const tokenB = `b18b-auth-b-${suffixB}`;
const secrets: string[] = [];

let appA: B18AppHarness;
let appB: B18AppHarness;
let connections: KnowledgeConnections;
let spaceA = '';
let spaceB = '';
let spacePartial = '';
let spaceForeign = '';
let sourceA = '';
let segmentA = '';
let sourceB = '';
let segmentB = '';
let sourceForeign = '';
let segmentForeign = '';
let searchKey = '';
let readOnlyKey = '';
let scopeKey = '';
let expiredKey = '';
let foreignKey = '';
let beforeCounts: Record<string, number> = {};

interface ConsumerResult {
  ok?: boolean;
  status?: number;
  data?: SearchApiResponse;
  citationIds?: string[];
  citationRecord?: { citationId?: string; title?: string; segmentId?: string };
  citationRecords?: Array<{ citationId?: string; title?: string; segmentId?: string }>;
  citationQuoteFieldsPresent?: boolean;
  nextStep?: Record<string, unknown>;
  stopReason?: string;
  traceId?: string;
  requestId?: string;
  problem?: {
    error?: {
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    };
  };
}

function requiredOk(result: Record<string, unknown>): ConsumerResult {
  const typed = result as ConsumerResult;
  expect(typed.ok, JSON.stringify(result)).toBe(true);
  expect([200, 207]).toContain(typed.status);
  return typed;
}

function job(
  input: Omit<ConsumerJob, 'baseUrl' | 'workspaceId' | 'query' | 'tokenBudget'> & {
    query?: string;
    tokenBudget?: number;
  },
): ConsumerJob {
  return {
    baseUrl: appA.baseUrl,
    workspaceId: workspaceA,
    query: 'refund policy',
    tokenBudget: 5_000,
    ...input,
  };
}

async function request(
  app: B18AppHarness,
  workspaceId: string,
  token: string | null,
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
    requestId?: string;
  } = {},
) {
  return apiRequest(app, path, {
    workspaceId,
    token,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey ?? `b18b-req-${uniqueSuffix('req')}`,
    method: input.method,
    body: input.body,
  });
}

async function snapshotCounts(): Promise<Record<string, number>> {
  const models = registerKnowledgeModels(connections.mongo);
  const counts: Record<string, number> = {};
  for (const workspaceId of [workspaceA, workspaceB]) {
    counts[`${workspaceId}:sources`] = await models.KnowledgeSource.countDocuments({ workspaceId });
    counts[`${workspaceId}:segments`] = await models.KnowledgeSegment.countDocuments({
      workspaceId,
    });
    counts[`${workspaceId}:spaces`] = await models.KnowledgeSpace.countDocuments({ workspaceId });
    counts[`${workspaceId}:jobs`] = await models.KnowledgeJob.countDocuments({ workspaceId });
  }
  return counts;
}

async function issueCitation(
  token: string,
  spaceId: string,
  query = 'refund policy',
): Promise<{ citationId: string; search: SearchApiResponse }> {
  const result = await request(appA, workspaceA, token, '/v1/knowledge/search/hybrid', {
    method: 'POST',
    body: {
      knowledgeSpaceId: spaceId,
      query,
      tokenBudget: 5_000,
      searchMode: 'hybrid',
      usingRerank: false,
    },
  });
  expect(result.response.status, result.text).toBe(200);
  const search = result.payload.data as SearchApiResponse;
  expect(search.items.length).toBeGreaterThan(0);
  return { citationId: search.items[0]!.citation.citationId, search };
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b18b_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  appA = await startB18App({
    suffix: suffixA,
    workspaceId: workspaceA,
    memberId: memberA,
    authToken: tokenA,
  });
  appB = await startB18App({
    suffix: suffixB,
    workspaceId: workspaceB,
    memberId: memberB,
    authToken: tokenB,
  });

  const createdA = await createSpace(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-a`,
  });
  const createdB = await createSpace(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-b`,
  });
  const createdPartial = await createSpace(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-partial`,
  });
  const createdForeign = await createSpace(appB, {
    adminToken: tokenB,
    workspaceId: workspaceB,
    suffix: `${suffixB}-foreign`,
  });
  spaceA = createdA.id;
  spaceB = createdB.id;
  spacePartial = createdPartial.id;
  spaceForeign = createdForeign.id;

  const sourceSegmentA = await createSourceAndSegment(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    spaceId: spaceA,
    suffix: `${suffixA}-source`,
    title: `B18B refund policy A ${suffixA}`,
    text: 'Refund policy: refunds take five business days.',
  });
  const sourceSegmentB = await createSourceAndSegment(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    spaceId: spaceB,
    suffix: `${suffixA}-source-b`,
    title: `B18B refund policy B ${suffixA}`,
    text: 'Refund policy: refunds take five business days.',
  });
  sourceA = sourceSegmentA.sourceId;
  segmentA = sourceSegmentA.segmentId;
  sourceB = sourceSegmentB.sourceId;
  segmentB = sourceSegmentB.segmentId;
  await createSourceAndSegment(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    spaceId: spacePartial,
    suffix: `${suffixA}-partial-source`,
    title: `B18B partial policy ${suffixA}`,
    text: 'Partial Space drift fixture.',
  });
  const sourceSegmentForeign = await createSourceAndSegment(appB, {
    adminToken: tokenB,
    workspaceId: workspaceB,
    spaceId: spaceForeign,
    suffix: `${suffixB}-source`,
    title: `B18B foreign refund policy ${suffixB}`,
    text: 'Foreign tenant refund policy.',
  });
  sourceForeign = sourceSegmentForeign.sourceId;
  segmentForeign = sourceSegmentForeign.segmentId;

  connections = await openConnections();
  const contextA: TenantContext = {
    workspaceId: workspaceA,
    memberId: memberA,
    requestId: `seed-${suffixA}`,
    traceId: suffixA.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
    isWorkspaceOwner: true,
  };
  await seedIndexedSegment(connections, contextA, {
    spaceId: spaceA,
    segmentId: segmentA,
    text: 'Refund policy: refunds take five business days.',
    label: 'A',
  });
  await seedIndexedSegment(connections, contextA, {
    spaceId: spaceB,
    segmentId: segmentB,
    text: 'Refund policy: refunds take five business days.',
    label: 'B',
  });
  const contextB: TenantContext = {
    workspaceId: workspaceB,
    memberId: memberB,
    requestId: `seed-${suffixB}`,
    traceId: suffixB.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
    isWorkspaceOwner: true,
  };
  await seedIndexedSegment(connections, contextB, {
    spaceId: spaceForeign,
    segmentId: segmentForeign,
    text: 'Foreign tenant refund policy.',
    label: 'B-foreign',
  });

  const search = await createApiKey(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-search`,
    scopes: ['knowledge:read', 'knowledge:search'],
    spaceIds: [spaceA, spaceB, spacePartial],
  });
  const readOnly = await createApiKey(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-read`,
    scopes: ['knowledge:read'],
    spaceIds: [spaceA],
  });
  const scope = await createApiKey(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-scope`,
    scopes: ['knowledge:read', 'knowledge:search'],
    spaceIds: [spaceA],
  });
  const expired = await createApiKey(appA, {
    adminToken: tokenA,
    workspaceId: workspaceA,
    suffix: `${suffixA}-expired`,
    scopes: ['knowledge:read', 'knowledge:search'],
    spaceIds: [spaceA],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const foreign = await createApiKey(appB, {
    adminToken: tokenB,
    workspaceId: workspaceB,
    suffix: `${suffixB}-foreign`,
    scopes: ['knowledge:read', 'knowledge:search'],
    spaceIds: [spaceForeign],
  });
  searchKey = search.secret;
  readOnlyKey = readOnly.secret;
  scopeKey = scope.secret;
  expiredKey = expired.secret;
  foreignKey = foreign.secret;
  secrets.push(searchKey, readOnlyKey, scopeKey, expiredKey, foreignKey);
  beforeCounts = await snapshotCounts();
}, 300_000);

afterAll(async () => {
  const after = connections ? await snapshotCounts() : {};
  const objectCleanup = connections
    ? {
        workspaceA: await cleanupWorkspaceObjects(connections, workspaceA),
        workspaceB: await cleanupWorkspaceObjects(connections, workspaceB),
      }
    : {};
  writeJson(join(evidenceDir, 'downstream-summary.json'), {
    runId,
    workspaceA,
    workspaceB,
    spaces: { spaceA, spaceB, spacePartial, spaceForeign },
    sources: { sourceA, segmentA, sourceB, segmentB, sourceForeign, segmentForeign },
    beforeCounts,
    afterCounts: after,
    objectCleanup,
    providerMode: 'BLOCKED_PROVIDER',
    appAOutput: redact(appA?.output() ?? '', secrets),
    appBOutput: redact(appB?.output() ?? '', secrets),
  });
  if (connections) {
    const models = registerKnowledgeModels(connections.mongo);
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
    }
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await connections.pg.query(`DELETE FROM ${table} WHERE workspace_id = ANY($1::text[])`, [
        [workspaceA, workspaceB],
      ]);
    }
    await connections.close();
  }
  await appA?.close();
  await appB?.close();
}, 120_000);

describe('L1-B18-B independent downstream consumers over real HTTP', () => {
  it('DOWN-001-P01/N01 merges two Spaces and distinguishes partial and empty', async () => {
    const workflow = requiredOk(
      await spawnConsumer(
        job({
          role: 'workflow',
          requestId: `b18b-workflow-${uniqueSuffix('id')}`,
          knowledgeSpaceId: spaceA,
          knowledgeSpaceIds: [spaceA, spaceB],
        }),
        searchKey,
      ),
    );
    expect(workflow.status).toBe(200);
    expect(workflow.data?.mode).toBe('multi_space');
    expect(workflow.data?.items.length).toBeGreaterThan(0);
    expect(workflow.nextStep).toMatchObject({ name: 'workflow-complete', sideEffects: 'none' });
    expect(workflow.traceId).toBeTruthy();
    expect(workflow.requestId).toBeTruthy();

    const normalized = workflow.data!.items.map((item) =>
      `${item.segment.question}${item.segment.answer}`.replace(/[^\p{L}\p{N}]/gu, ''),
    );
    expect(new Set(normalized).size).toBe(normalized.length);

    const provider = await partialProvider();
    const partialApp = await startB18App({
      suffix: `${suffixA}-partial`,
      workspaceId: workspaceA,
      memberId: memberA,
      authToken: tokenA,
      modelMode: 'real',
      aiproxyBaseUrl: provider.baseUrl,
    });
    try {
      await setEmbeddingBinding(
        connections,
        {
          workspaceId: workspaceA,
          memberId: memberA,
          requestId: `partial-binding-${suffixA}`,
          traceId: suffixA.padEnd(32, '0').slice(0, 32),
          scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
          isWorkspaceOwner: true,
        },
        { spaceId: spacePartial, modelId: 'mock-embedding-1024', dimension: 1024 },
      );
      const partial = requiredOk(
        await spawnConsumer(
          {
            ...job({
              role: 'workflow',
              requestId: `b18b-partial-${uniqueSuffix('id')}`,
              knowledgeSpaceId: spaceA,
              knowledgeSpaceIds: [spaceA, spacePartial],
            }),
            baseUrl: partialApp.baseUrl,
          },
          searchKey,
        ),
      );
      expect(partial.status).toBe(207);
      expect(partial.stopReason).toBe('partial_dependency');
      expect(partial.data?.degraded?.length).toBeGreaterThan(0);
    } finally {
      await partialApp.close();
      await provider.close();
    }

    const empty = requiredOk(
      await spawnConsumer(
        job({
          role: 'workflow',
          requestId: `b18b-empty-${uniqueSuffix('id')}`,
          knowledgeSpaceId: spacePartial,
          knowledgeSpaceIds: [spacePartial],
          query: `no-hit-${suffixA}`,
        }),
        searchKey,
      ),
    );
    expect(empty.status).toBe(200);
    expect(empty.data?.items).toEqual([]);
    expect(empty.stopReason).toBe('empty');
  }, 180_000);

  it('DOWN-001-P01 de-duplicates a repeated Space ID without double weight', async () => {
    const once = await request(appA, workspaceA, searchKey, '/v1/knowledge/search/multi-space', {
      method: 'POST',
      body: {
        knowledgeSpaceId: spaceA,
        knowledgeSpaceIds: [spaceA],
        query: 'refund policy',
        tokenBudget: 5_000,
        searchMode: 'hybrid',
      },
    });
    const repeated = await request(
      appA,
      workspaceA,
      searchKey,
      '/v1/knowledge/search/multi-space',
      {
        method: 'POST',
        body: {
          knowledgeSpaceId: spaceA,
          knowledgeSpaceIds: [spaceA, spaceA],
          query: 'refund policy',
          tokenBudget: 5_000,
          searchMode: 'hybrid',
        },
      },
    );
    expect(once.response.status).toBe(200);
    expect(repeated.response.status).toBe(200);
    const onceData = once.payload.data as SearchApiResponse;
    const repeatedData = repeated.payload.data as SearchApiResponse;
    expect(repeatedData.items.map((item) => item.segment.id)).toEqual(
      onceData.items.map((item) => item.segment.id),
    );
  });

  it('DOWN-002-P01/N01 validates Agent input and consumes a Citation', async () => {
    const agent = requiredOk(
      await spawnConsumer(
        job({
          role: 'agent',
          requestId: `b18b-agent-${uniqueSuffix('id')}`,
          knowledgeSpaceId: spaceA,
        }),
        searchKey,
      ),
    );
    expect(agent.status).toBe(200);
    expect(agent.data?.mode).toBe('semantic');
    expect(agent.citationIds?.length).toBeGreaterThan(0);
    expect(agent.citationRecord?.citationId).toBe(agent.citationIds?.[0]);

    const invalidCases = [
      {
        label: 'unknown-filter',
        body: {
          knowledgeSpaceId: spaceA,
          query: 'refund',
          tokenBudget: 100,
          filters: { unknownField: true },
        },
      },
      {
        label: 'unknown-operator',
        body: {
          knowledgeSpaceId: spaceA,
          query: 'refund',
          tokenBudget: 100,
          filters: {
            logic: 'AND',
            conditions: [
              { tagId: '65f1e5b2a1c9d4b7e8f01234', tagType: 'string', operator: '$ts', value: 'x' },
            ],
          },
        },
      },
      {
        label: 'missing-query',
        body: { knowledgeSpaceId: spaceA, tokenBudget: 100 },
      },
      {
        label: 'negative-budget',
        body: { knowledgeSpaceId: spaceA, query: 'refund', tokenBudget: -1 },
      },
      {
        label: 'malicious-regex',
        body: {
          knowledgeSpaceId: spaceA,
          query: 'refund',
          tokenBudget: 100,
          filters: {
            logic: 'AND',
            conditions: [
              {
                tagId: '65f1e5b2a1c9d4b7e8f01234',
                tagType: 'string',
                operator: '$regex',
                value: '(a+)+$',
              },
            ],
          },
        },
      },
      {
        label: 'oversized-query',
        body: { knowledgeSpaceId: spaceA, query: 'x'.repeat(20_001), tokenBudget: 100 },
      },
    ];
    const safeRows = [];
    for (const testCase of invalidCases) {
      const response = await request(appA, workspaceA, searchKey, '/v1/knowledge/search/semantic', {
        method: 'POST',
        body: testCase.body,
        requestId: `b18b-invalid-${testCase.label}-${suffixA}`,
      });
      expect(response.response.status, `${testCase.label}: ${response.text}`).toBe(400);
      expect(response.payload.success).toBe(false);
      expect(JSON.stringify(response.payload)).not.toContain('B18B refund policy');
      safeRows.push({
        case: testCase.label,
        status: response.response.status,
        code: response.payload.error?.code,
        requestId: response.payload.requestId,
        traceId: response.payload.traceId,
      });
    }
    writeJson(join(evidenceDir, 'down-002-invalid-inputs.json'), safeRows);
  }, 120_000);

  it('DOWN-001/002-A01 enforces scope, Space scope, tenant and credential status', async () => {
    const endpoint = '/v1/knowledge/search/semantic';
    const body = {
      knowledgeSpaceId: spaceA,
      query: 'refund policy',
      tokenBudget: 5_000,
      searchMode: 'semantic',
    };
    const noCredential = await request(appA, workspaceA, null, endpoint, { method: 'POST', body });
    expect(noCredential.response.status).toBe(401);
    const malformed = await request(appA, workspaceA, `kn_live_${'x'.repeat(48)}`, endpoint, {
      method: 'POST',
      body,
    });
    expect(malformed.response.status).toBe(401);
    const expired = await request(appA, workspaceA, expiredKey, endpoint, { method: 'POST', body });
    expect(expired.response.status).toBe(401);
    const wrongScope = await request(appA, workspaceA, readOnlyKey, endpoint, {
      method: 'POST',
      body,
    });
    expect(wrongScope.response.status).toBe(403);
    const deniedSpace = await request(appA, workspaceA, scopeKey, endpoint, {
      method: 'POST',
      body: { ...body, knowledgeSpaceId: spaceB },
    });
    expect(deniedSpace.response.status).toBe(403);
    const crossTenant = await request(appA, workspaceA, scopeKey, endpoint, {
      method: 'POST',
      body: { ...body, knowledgeSpaceId: spaceForeign },
    });
    expect([403, 404]).toContain(crossTenant.response.status);
    const forgedWorkspace = await request(appA, workspaceB, scopeKey, endpoint, {
      method: 'POST',
      body,
    });
    expect([401, 403]).toContain(forgedWorkspace.response.status);
    for (const result of [
      noCredential,
      malformed,
      expired,
      wrongScope,
      deniedSpace,
      crossTenant,
      forgedWorkspace,
    ]) {
      expect(JSON.stringify(result.payload)).not.toContain(`B18B refund policy A ${suffixA}`);
      expect(result.payload.success).toBe(false);
    }
  });

  it('DOWN-003-P01/N01/UI supports Chat context and Citation recovery', async () => {
    const chat = requiredOk(
      await spawnConsumer(
        job({
          role: 'chat',
          requestId: `b18b-chat-${uniqueSuffix('id')}`,
          knowledgeSpaceId: spaceA,
          tokenBudget: 12,
        }),
        searchKey,
      ),
    );
    expect(chat.status).toBe(200);
    expect(chat.citationIds?.length).toBeGreaterThan(0);
    expect(chat.citationRecords?.length).toBe(chat.citationIds?.length);
    expect(chat.contextCharacters).toBeLessThanOrEqual(48);
    expect(['completed', 'token_budget']).toContain(chat.stopReason);

    const citationIds = chat.citationIds!;
    for (const citationId of citationIds) {
      const fetched = await request(
        appA,
        workspaceA,
        searchKey,
        `/v1/knowledge/citations/${encodeURIComponent(citationId)}`,
      );
      expect(fetched.response.status).toBe(200);
      expect(fetched.payload.data).toMatchObject({ citationId });
    }

    const degraded = await request(appA, workspaceA, searchKey, '/v1/knowledge/search/hybrid', {
      method: 'POST',
      body: {
        knowledgeSpaceId: spaceA,
        query: 'refund policy',
        tokenBudget: 5_000,
        searchMode: 'hybrid',
        usingRerank: true,
      },
    });
    expect(degraded.response.status).toBe(200);
    expect((degraded.payload.data as SearchApiResponse).degraded).toContain(
      'rerank_not_configured',
    );
  }, 120_000);

  it('TEST-X-DOWNSTREAM-CITATION revokes Source ACL for old Citations', async () => {
    const material = await createSourceAndSegment(appA, {
      adminToken: tokenA,
      workspaceId: workspaceA,
      spaceId: spacePartial,
      suffix: `${suffixA}-acl-source`,
      title: `B18B ACL policy ${suffixA}`,
      text: 'ACL protected refund policy.',
    });
    const context: TenantContext = {
      workspaceId: workspaceA,
      memberId: memberA,
      requestId: `acl-seed-${suffixA}`,
      traceId: suffixA.padEnd(32, '0').slice(0, 32),
      scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
      isWorkspaceOwner: true,
    };
    await seedIndexedSegment(connections, context, {
      spaceId: spacePartial,
      segmentId: material.segmentId,
      text: 'ACL protected refund policy.',
      label: 'ACL',
    });
    const aclKey = await createApiKey(appA, {
      adminToken: tokenA,
      workspaceId: workspaceA,
      suffix: `${suffixA}-acl-key`,
      scopes: ['knowledge:read', 'knowledge:search'],
      spaceIds: [spacePartial],
    });
    secrets.push(aclKey.secret);
    const issued = await issueCitation(aclKey.secret, spacePartial, 'ACL protected');
    const acl = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/resources/source/${material.sourceId}/acl`,
    );
    expect(acl.response.status).toBe(200);
    const aclData = acl.payload.data as { snapshotVersion?: number };
    expect(aclData.snapshotVersion).toBeTypeOf('number');
    const source = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/sources/${material.sourceId}`,
    );
    expect(source.response.status).toBe(200);
    const sourceBeforeEnable = source.payload.data as {
      version: number;
      permissionRevision: number;
    };
    const enabled = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/sources/${material.sourceId}/permissions/enable`,
      {
        method: 'POST',
        body: {
          version: sourceBeforeEnable.version,
          expectedPermissionRevision: sourceBeforeEnable.permissionRevision,
        },
      },
    );
    expect(enabled.response.status, enabled.text).toBe(200);
    const sourceAfterEnable = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/sources/${material.sourceId}`,
    );
    expect(sourceAfterEnable.response.status).toBe(200);
    expect(
      (sourceAfterEnable.payload.data as { permissionRevision: number }).permissionRevision,
    ).toBeGreaterThan(sourceBeforeEnable.permissionRevision);
    const revoked = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/resources/source/${material.sourceId}/acl`,
      {
        method: 'PUT',
        body: {
          inheritMode: 'override',
          entries: [],
          version: (sourceAfterEnable.payload.data as { version: number }).version,
        },
      },
    );
    expect(revoked.response.status, revoked.text).toBe(200);
    const sourceAfterRevoke = await request(
      appA,
      workspaceA,
      tokenA,
      `/v1/knowledge/sources/${material.sourceId}`,
    );
    expect(sourceAfterRevoke.response.status).toBe(200);
    const permissionRevisionAfterRevoke = (
      sourceAfterRevoke.payload.data as { permissionRevision: number }
    ).permissionRevision;
    expect(permissionRevisionAfterRevoke).toBeGreaterThan(
      (sourceAfterEnable.payload.data as { permissionRevision: number }).permissionRevision,
    );
    const afterRevoke = await request(
      appA,
      workspaceA,
      aclKey.secret,
      `/v1/knowledge/citations/${encodeURIComponent(issued.citationId)}`,
    );
    writeJson(join(evidenceDir, 'citation-revocation.json'), {
      spaceId: spacePartial,
      sourceId: material.sourceId,
      citationId: issued.citationId,
      before: '200',
      aclSnapshotVersion: aclData.snapshotVersion,
      enableStatus: enabled.response.status,
      revokeStatus: revoked.response.status,
      permissionRevisionBefore: sourceBeforeEnable.permissionRevision,
      permissionRevisionAfterEnable: (
        sourceAfterEnable.payload.data as { permissionRevision: number }
      ).permissionRevision,
      permissionRevisionAfterRevoke,
      after: afterRevoke.response.status,
      code: afterRevoke.payload.error?.code,
    });
    expect([403, 404]).toContain(afterRevoke.response.status);
    expect(JSON.stringify(afterRevoke.payload)).not.toContain('ACL protected refund policy');
  }, 120_000);

  it('C01 isolates concurrent Workflow and tenant state', async () => {
    const calls = await Promise.all([
      spawnConsumer(
        job({
          role: 'workflow',
          requestId: `b18b-c1-${suffixA}`,
          knowledgeSpaceId: spaceA,
          knowledgeSpaceIds: [spaceA],
        }),
        searchKey,
      ),
      spawnConsumer(
        job({
          role: 'workflow',
          requestId: `b18b-c2-${suffixA}`,
          knowledgeSpaceId: spaceB,
          knowledgeSpaceIds: [spaceB],
        }),
        searchKey,
      ),
      spawnConsumer(
        {
          ...job({
            role: 'workflow',
            requestId: `b18b-c3-${suffixA}`,
            knowledgeSpaceId: spaceForeign,
            knowledgeSpaceIds: [spaceForeign],
          }),
          workspaceId: workspaceB,
          baseUrl: appB.baseUrl,
        },
        foreignKey,
      ),
    ]);
    writeJson(join(evidenceDir, 'concurrent-consumer-results.json'), calls);
    const rows = calls.map(requiredOk);
    expect(new Set(rows.map((entry) => entry.requestId)).size).toBe(3);
    expect(rows[0]?.citationIds?.every((id) => rows[1]?.citationIds?.includes(id) === false)).toBe(
      true,
    );
    expect(rows[2]?.data?.items[0]?.citation.sourceId).not.toBe(sourceA);
    expect(JSON.stringify(rows[0])).not.toContain(`B18B refund policy B ${suffixA}`);
    expect(JSON.stringify(rows[1])).not.toContain(`B18B refund policy A ${suffixA}`);
  }, 180_000);

  it('TEST-X-API-003 returns 429 with retry headers and never reports empty success', async () => {
    const endpoint = '/v1/knowledge/search/semantic';
    const responses = await Promise.all(
      Array.from({ length: 75 }, (_, index) =>
        fetch(`${appA.baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${searchKey}`,
            'x-workspace-id': workspaceA,
            'x-request-id': `b18b-rate-${suffixA}-${index}`,
            'content-type': 'application/json',
            'idempotency-key': `b18b-rate-${suffixA}-${index}`,
          },
          body: '{}',
        }),
      ),
    );
    const limited = responses.filter((response) => response.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    for (const response of limited) {
      expect(response.headers.get('ratelimit-limit')).toBeTruthy();
      expect(response.headers.get('retry-after')).toBeTruthy();
      const payload = (await response.json()) as {
        success: boolean;
        error?: { code?: string; retryable?: boolean };
        traceId?: string;
      };
      expect(payload).toMatchObject({
        success: false,
        error: { code: 'KNOWLEDGE_RATE_LIMITED', retryable: true },
      });
      expect(payload.traceId).toBeTruthy();
    }
  }, 180_000);

  it('S01 leaves knowledge business counts unchanged by consumer reads', async () => {
    const after = await snapshotCounts();
    expect(after[`${workspaceA}:sources`]).toBe(beforeCounts[`${workspaceA}:sources`]! + 1);
    expect(after[`${workspaceA}:segments`]).toBe(beforeCounts[`${workspaceA}:segments`]! + 1);
    expect(after[`${workspaceA}:spaces`]).toBe(beforeCounts[`${workspaceA}:spaces`]!);
    expect(after[`${workspaceA}:jobs`]).toBe(beforeCounts[`${workspaceA}:jobs`]! + 2);
    expect(after[`${workspaceB}:spaces`]).toBe(beforeCounts[`${workspaceB}:spaces`]!);
  });
});
