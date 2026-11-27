import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Redis from '../../packages/service/node_modules/ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeMongoConnection,
  prefixedRedisKey,
  registerKnowledgeModels,
  type KnowledgeConnections,
} from '../../packages/service/src';
import { RUNTIME_ROUTE_REGISTRY } from '../../packages/contracts/src/openapi/route-registry';
import { createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const runId = process.env.B19_RUN_ID ?? `b19-a-20261122-220039-${suffix.slice(0, 4)}`;
const workspaceId = `${runId}-workspace`;
const memberId = `${runId}-member-owner`;
const adminToken = `${runId}-admin-token`;
const noScopeToken = `${runId}-no-scope-token`;

let app: S4AppHarness;
let noScopeApp: S4AppHarness;
let mongo: KnowledgeConnections['mongo'];
let redis: Redis;

type ApiProblem = {
  success: false;
  error: {
    code: string;
    retryable?: boolean;
    requestId?: string;
    traceId?: string;
    title?: string;
    status?: number;
  };
  requestId?: string;
  traceId?: string;
};

interface RequestResult {
  response: Response;
  payload: unknown;
  text: string;
}

interface CreatedKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  spaceIds: string[];
  status: string;
  version: number;
  expiresAt: string | null;
  updatedAt: string;
  secret: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

function traceParent(traceId: string): string {
  return `00-${traceId}-00f067aa0ba902b7-01`;
}

async function request(
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    token?: string | null;
    baseUrl?: string;
    workspace?: string;
    body?: unknown;
    rawBody?: string;
    idempotencyKey?: string;
    requestId?: string;
    traceId?: string;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<RequestResult> {
  const response = await fetch(`${input.baseUrl ?? app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      'x-workspace-id': input.workspace ?? workspaceId,
      ...(input.token === null ? {} : { authorization: `Bearer ${input.token ?? adminToken}` }),
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
      ...(input.traceId ? { traceparent: traceParent(input.traceId) } : {}),
      ...(input.body !== undefined || input.rawBody !== undefined
        ? { 'content-type': input.contentType ?? 'application/json' }
        : input.contentType
          ? { 'content-type': input.contentType }
          : {}),
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      ...input.headers,
    },
    ...(input.rawBody !== undefined
      ? { body: input.rawBody }
      : input.body !== undefined
        ? { body: JSON.stringify(input.body) }
        : {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { response, payload, text };
}

async function createKey(input: {
  label: string;
  scopes?: string[];
  spaceIds?: string[];
  expiresAt?: string | null;
  idempotencyKey?: string;
}): Promise<CreatedKey> {
  const created = await request('/v1/knowledge/api-keys', {
    method: 'POST',
    idempotencyKey: input.idempotencyKey ?? `b19-create-${input.label}-${suffix}`,
    body: {
      name: `B19 ${input.label} ${suffix}`,
      scopes: input.scopes ?? ['knowledge:read', 'knowledge:search'],
      spaceIds: input.spaceIds ?? [],
      expiresAt: input.expiresAt ?? null,
    },
  });
  expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
  expect(created.payload).toMatchObject({ success: true });
  const data = (created.payload as { data: Record<string, unknown> }).data;
  expect(typeof data.secret).toBe('string');
  expect(String(data.secret).startsWith('kn_live_')).toBe(true);
  return data as unknown as CreatedKey;
}

function concretePath(path: string): string {
  return path.replaceAll(/\{[^}]+\}/g, '65f1e5b2a1c9d4b7e8f01234');
}

const publicOperationIds = new Set<string>();
{
  const openApi = JSON.parse(
    readFileSync(join(root, 'packages/contracts/openapi/openapi.json'), 'utf8'),
  ) as {
    paths: Record<string, Record<string, { operationId?: string; security?: unknown[] }>>;
  };
  for (const item of Object.values(openApi.paths)) {
    for (const operation of Object.values(item)) {
      if (
        operation.operationId &&
        Array.isArray(operation.security) &&
        operation.security.length === 0
      ) {
        publicOperationIds.add(operation.operationId);
      }
    }
  }
}

function isPublicOperation(operationId: string): boolean {
  return publicOperationIds.has(operationId);
}

function evidencePath(name: string): string {
  const evidenceDir = process.env.B19_EVIDENCE_DIR?.trim();
  return evidenceDir ? join(evidenceDir, name) : join(root, 'test-results', 'b19-apikey', name);
}

function writeEvidence(name: string, value: unknown): void {
  const target = evidencePath(name);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken: adminToken });
  noScopeApp = await startS4App({
    suffix: `${suffix}-noscope`,
    workspaceId,
    memberId,
    authToken: noScopeToken,
    scopes: '',
  });
  mongo = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  redis = new Redis(requiredEnv('KB_TEST_REDIS_URL'), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
}, 240_000);

afterAll(async () => {
  let redisKeysBefore = 0;
  let redisKeysAfter = 0;
  if (redis) {
    const rateKey = (suffix: string) =>
      prefixedRedisKey(process.env.KB_REDIS_PREFIX ?? '', `kb-rate:${workspaceId}:${suffix}`);
    const keys = await redis.keys(rateKey('*'));
    redisKeysBefore = keys.length;
    if (keys.length > 0) await redis.del(...keys);
    redisKeysAfter = (await redis.keys(rateKey('*'))).length;
    await redis.quit();
  }
  if (mongo) {
    const models = registerKnowledgeModels(mongo);
    const before = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => {
          return [name, await model.countDocuments({ workspaceId })] as const;
        }),
      ),
    );
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId });
    }
    const after = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => {
          return [name, await model.countDocuments({ workspaceId })] as const;
        }),
      ),
    );
    writeEvidence('cleanup-reconciliation.json', {
      workspaceId,
      redisKeysBefore,
      redisKeysAfter,
      mongoBefore: before,
      mongoAfter: after,
    });
    await mongo.close();
  }
  await noScopeApp?.close();
  await app?.close();
});

describe('L1-B19-API-003 API Key lifecycle over real HTTP', () => {
  it('L1-B19-API-003-P01 创建 API Key 后仅返回一次 secret 且列表仅显示 prefix', async () => {
    const requestId = `b19-${suffix}-create`;
    const traceId = `${suffix}cccccccccccccccccccc`.slice(0, 32);
    const created = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `b19-lifecycle-create-${suffix}`,
      requestId,
      traceId,
      headers: {
        'x-forwarded-for': '203.0.113.19',
        'user-agent': 'B19-prelight-agent',
      },
      body: {
        name: `B19 lifecycle ${suffix}`,
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    expect(created.response.headers.get('x-request-id')).toBe(requestId);
    expect(created.response.headers.get('x-trace-id')).toBe(traceId);
    const payload = created.payload as {
      success: true;
      data: {
        id: string;
        workspaceId: string;
        name: string;
        keyPrefix: string;
        scopes: string[];
        spaceIds: string[];
        status: string;
        version: number;
        expiresAt: string;
        updatedAt: string;
        secret: string;
      };
      requestId: string;
      traceId: string;
    };
    expect(payload).toMatchObject({
      success: true,
      requestId,
      traceId,
      data: {
        workspaceId,
        status: 'active',
        version: 1,
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [],
      },
    });
    expect(payload.data.secret.startsWith('kn_live_')).toBe(true);
    expect(payload.data.keyPrefix).toBe(payload.data.secret.slice(0, 12));

    const replay = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `b19-lifecycle-create-${suffix}`,
      body: {
        name: `B19 lifecycle ${suffix}`,
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [],
        expiresAt: payload.data.expiresAt,
      },
    });
    expect(replay.response.status).toBe(409);
    expect(replay.payload).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_CONFLICT',
        details: { reason: 'one_time_secret_already_returned' },
      },
    });

    const listed = await request('/v1/knowledge/api-keys?limit=1&sort=-createdAt');
    expect(listed.response.status).toBe(200);
    expect(listed.payload).toMatchObject({
      success: true,
      data: {
        pageInfo: { hasMore: expect.any(Boolean) },
      },
    });
    const serialized = JSON.stringify(listed.payload);
    expect(serialized.includes(payload.data.secret)).toBe(false);
    expect(serialized.includes('secretHash')).toBe(false);
    expect(
      (listed.payload as { data: { items: Array<{ keyPrefix: string }> } }).data.items[0],
    ).toMatchObject({ keyPrefix: payload.data.keyPrefix });

    const keys = registerKnowledgeModels(mongo).KnowledgeApiKey;
    const document = await keys
      .findOne({ workspaceId, _id: payload.data.id })
      .select('+secretHash')
      .lean();
    expect(document?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(document)).not.toContain(payload.data.secret);
  });

  it('L1-B19-API-003-N01 rejects invalid scopes, duplicate scopes and invalid Space bindings without creation', async () => {
    const keys = registerKnowledgeModels(mongo).KnowledgeApiKey;
    const before = await keys.countDocuments({ workspaceId });
    const cases = [
      {
        id: 'empty-scope',
        body: { name: `empty ${suffix}`, scopes: [], spaceIds: [] },
        expected: 422,
      },
      {
        id: 'duplicate-scope',
        body: {
          name: `duplicate ${suffix}`,
          scopes: ['knowledge:read', 'knowledge:read'],
          spaceIds: [],
        },
        expected: 422,
      },
      {
        id: 'unknown-scope',
        body: { name: `unknown ${suffix}`, scopes: ['knowledge:unknown'], spaceIds: [] },
        expected: 422,
      },
      {
        id: 'missing-space',
        body: {
          name: `missing-space ${suffix}`,
          scopes: ['knowledge:read'],
          spaceIds: ['65f1e5b2a1c9d4b7e8f09999'],
        },
        expected: 404,
      },
    ] as const;
    const actual: Array<{ id: string; expected: number; actual: number; code: unknown }> = [];
    for (const testCase of cases) {
      const rejected = await request('/v1/knowledge/api-keys', {
        method: 'POST',
        idempotencyKey: `b19-invalid-${testCase.id}-${suffix}`,
        body: testCase.body,
      });
      actual.push({
        id: testCase.id,
        expected: testCase.expected,
        actual: rejected.response.status,
        code:
          rejected.payload && typeof rejected.payload === 'object' && 'error' in rejected.payload
            ? (rejected.payload as ApiProblem).error.code
            : null,
      });
      expect(rejected.payload).toMatchObject({ success: false });
    }
    expect(actual).toEqual(
      cases.map((testCase) => ({
        id: testCase.id,
        expected: testCase.expected,
        actual: testCase.expected,
        code:
          testCase.id === 'missing-space'
            ? 'KNOWLEDGE_NOT_FOUND'
            : 'KNOWLEDGE_API_KEY_SCOPE_INVALID',
      })),
    );
    expect(await keys.countDocuments({ workspaceId })).toBe(before);

    const updateTarget = await createKey({ label: 'empty-update-scope' });
    const emptyUpdate = await request(`/v1/knowledge/api-keys/${updateTarget.id}`, {
      method: 'PATCH',
      idempotencyKey: `b19-empty-update-scope-${suffix}`,
      body: { scopes: [], version: updateTarget.version },
    });
    expect(emptyUpdate.response.status).toBe(422);
    expect(emptyUpdate.payload).toMatchObject({
      success: false,
      error: { code: 'KNOWLEDGE_API_KEY_SCOPE_INVALID' },
    });
    const unchanged = (
      (await request(`/v1/knowledge/api-keys?limit=200`)).payload as {
        data: { items: Array<{ id: string; version: number }> };
      }
    ).data.items.find((item) => item.id === updateTarget.id);
    expect(unchanged?.version).toBe(updateTarget.version);
  });

  it('L1-B19-API-003-S01 updates name with CAS, increments version and records safe audit', async () => {
    const key = await createKey({ label: 'cas-update' });
    const updated = await request(`/v1/knowledge/api-keys/${key.id}`, {
      method: 'PATCH',
      idempotencyKey: `b19-update-${suffix}`,
      requestId: `b19-${suffix}-update`,
      body: { name: `Renamed ${suffix}`, version: key.version },
    });
    expect(updated.response.status, JSON.stringify(updated.payload)).toBe(200);
    const updatedKey = (updated.payload as { data: typeof key }).data;
    expect(updatedKey.name).toBe(`Renamed ${suffix}`);
    expect(updatedKey.scopes).toEqual(key.scopes);
    expect(updatedKey.spaceIds).toEqual(key.spaceIds);
    expect(updatedKey.version).toBe(key.version + 1);

    const stale = await request(`/v1/knowledge/api-keys/${key.id}`, {
      method: 'PATCH',
      idempotencyKey: `b19-stale-${suffix}`,
      body: { name: `Stale ${suffix}`, version: key.version },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.payload).toMatchObject({
      success: false,
      error: { code: 'KNOWLEDGE_CONFLICT' },
    });

    const activeNoOp = await request(`/v1/knowledge/api-keys/${key.id}`, {
      method: 'PATCH',
      idempotencyKey: `b19-active-noop-${suffix}`,
      body: { status: 'active', version: updatedKey.version },
    });
    expect(activeNoOp.response.status).toBe(200);
    expect((activeNoOp.payload as { data: { version: number } }).data.version).toBe(
      updatedKey.version + 1,
    );

    const audit = await request(`/v1/knowledge/audit-events?action=api_key.update&limit=50`);
    expect(audit.response.status).toBe(200);
    const events = (
      audit.payload as {
        data: {
          items: Array<{
            action: string;
            requestId: string;
            traceId: string;
            safeDiff: Record<string, unknown>;
          }>;
        };
      }
    ).data.items;
    const event = events.find((item) => item.requestId === `b19-${suffix}-update`);
    expect(event).toMatchObject({ action: 'api_key.update' });
    expect(JSON.stringify(event)).not.toContain(key.secret);
    expect(JSON.stringify(event)).not.toContain('secretHash');
  });

  it('L1-B19-API-003-C01 rotates with overlap and chain-revokes every secret', async () => {
    const key = await createKey({ label: 'rotation', scopes: ['knowledge:read'] });
    const spaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: adminToken,
      workspaceId,
      suffix: `${suffix}-rotate`,
    });
    const beforeRotate = await request(`/v1/knowledge/spaces/${spaceId}`, { token: key.secret });
    expect(beforeRotate.response.status).toBe(200);

    const rotated = await request(`/v1/knowledge/api-keys/${key.id}/rotate`, {
      method: 'POST',
      idempotencyKey: `b19-rotate-${suffix}`,
      requestId: `b19-${suffix}-rotate`,
      body: { version: key.version },
    });
    expect(rotated.response.status, JSON.stringify(rotated.payload)).toBe(200);
    const successor = (rotated.payload as { data: typeof key }).data;
    expect(successor).toMatchObject({
      status: 'active',
      version: 1,
      rotatedFromKeyId: key.id,
    });
    expect(successor.secret.startsWith('kn_live_')).toBe(true);
    expect(successor.secret).not.toBe(key.secret);

    expect(
      (await request(`/v1/knowledge/spaces/${spaceId}`, { token: key.secret })).response.status,
    ).toBe(200);
    expect(
      (await request(`/v1/knowledge/spaces/${spaceId}`, { token: successor.secret })).response
        .status,
    ).toBe(200);

    const revoke = await request(
      `/v1/knowledge/api-keys/${successor.id}?expectedVersion=${successor.version}`,
      {
        method: 'DELETE',
        idempotencyKey: `b19-revoke-${suffix}`,
        requestId: `b19-${suffix}-revoke`,
      },
    );
    expect(revoke.response.status).toBe(204);
    expect(revoke.text).toBe('');
    expect(
      (await request(`/v1/knowledge/spaces/${spaceId}`, { token: key.secret })).response.status,
    ).toBe(401);
    expect(
      (await request(`/v1/knowledge/spaces/${spaceId}`, { token: successor.secret })).response
        .status,
    ).toBe(401);

    const list = await request('/v1/knowledge/api-keys?limit=200');
    const chain = (
      list.payload as { data: { items: Array<Record<string, unknown>> } }
    ).data.items.filter((item) => item.id === key.id || item.id === successor.id);
    expect(chain).toHaveLength(2);
    expect(chain.every((item) => item.status === 'revoked')).toBe(true);
  });

  it('L1-B19-API-003-C02 concurrent idempotency creates and rotates one business successor', async () => {
    const createKeyValue = `b19-concurrent-create-${suffix}`;
    const createBody = {
      name: `Concurrent create ${suffix}`,
      scopes: ['knowledge:read'],
      spaceIds: [],
      expiresAt: null,
    };
    const creates = await Promise.all(
      Array.from({ length: 8 }, () =>
        request('/v1/knowledge/api-keys', {
          method: 'POST',
          idempotencyKey: createKeyValue,
          body: createBody,
        }),
      ),
    );
    const successfulCreates = creates.filter((result) => result.response.status === 201);
    expect(successfulCreates).toHaveLength(1);
    const successfulSecret = (successfulCreates[0]!.payload as { data: { secret: string } }).data
      .secret;
    for (const replay of creates.filter((result) => result !== successfulCreates[0])) {
      expect([409, 500]).toContain(replay.response.status);
      expect(replay.text).not.toContain(successfulSecret);
    }
    expect(
      await registerKnowledgeModels(mongo).KnowledgeApiKey.countDocuments({
        workspaceId,
        name: createBody.name,
      }),
    ).toBe(1);

    const key = await createKey({ label: 'concurrent-rotate', scopes: ['knowledge:read'] });
    const rotateKeyValue = `b19-concurrent-rotate-${suffix}`;
    const rotates = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(`/v1/knowledge/api-keys/${key.id}/rotate`, {
          method: 'POST',
          idempotencyKey: rotateKeyValue,
          body: { version: key.version },
        }),
      ),
    );
    expect(rotates.filter((result) => result.response.status === 200)).toHaveLength(1);
    const items = (
      (await request('/v1/knowledge/api-keys?limit=200')).payload as {
        data: { items: Array<Record<string, unknown>> };
      }
    ).data.items;
    expect(items.filter((item) => item.rotatedFromKeyId === key.id)).toHaveLength(1);
  });

  it('L1-B19-API-003-A01 rejects expired, revoked, malformed and cross-workspace credentials without creation', async () => {
    const expired = await createKey({
      label: 'expired',
      scopes: ['knowledge:read'],
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const spaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: adminToken,
      workspaceId,
      suffix: `${suffix}-auth`,
    });
    const auditBeforeUnknown = await registerKnowledgeModels(
      mongo,
    ).KnowledgeAuditEvent.countDocuments({
      workspaceId,
    });
    for (const token of [null, '', 'not-bearer', expired.secret, `kn_live_${'x'.repeat(43)}`]) {
      const rejected = await request(`/v1/knowledge/spaces/${spaceId}`, { token });
      expect(rejected.response.status).toBe(401);
      expect(JSON.stringify(rejected.payload)).not.toContain(expired.secret);
    }
    expect(
      await registerKnowledgeModels(mongo).KnowledgeAuditEvent.countDocuments({ workspaceId }),
    ).toBe(auditBeforeUnknown);

    const crossWorkspace = await request(`/v1/knowledge/spaces/${spaceId}`, {
      token: expired.secret,
      workspace: `ws_other_${suffix}`,
    });
    expect([401, 403]).toContain(crossWorkspace.response.status);

    const readKey = await createKey({ label: 'scope-denied', scopes: ['knowledge:read'] });
    const sourcesBefore = await registerKnowledgeModels(mongo).KnowledgeSource.countDocuments({
      workspaceId,
    });
    const deniedAuditBefore = await registerKnowledgeModels(
      mongo,
    ).KnowledgeAuditEvent.countDocuments({
      workspaceId,
      outcome: { $in: ['denied', 'restricted'] },
    });
    const forbidden = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
      method: 'POST',
      token: readKey.secret,
      idempotencyKey: `b19-scope-denied-${suffix}`,
      body: { kind: 'text', name: 'denied', searchEnabled: true, metadata: {} },
    });
    expect(forbidden.response.status).toBe(403);
    expect(
      await registerKnowledgeModels(mongo).KnowledgeSource.countDocuments({ workspaceId }),
    ).toBe(sourcesBefore);
    const deniedAuditAfter = await registerKnowledgeModels(
      mongo,
    ).KnowledgeAuditEvent.countDocuments({
      workspaceId,
      outcome: { $in: ['denied', 'restricted'] },
    });
    expect(deniedAuditAfter).toBe(deniedAuditBefore + 1);
    const sourceCreateRoute = RUNTIME_ROUTE_REGISTRY.find(
      (route) =>
        route.method === 'POST' &&
        route.path.includes('{spaceId}') &&
        route.path.endsWith('/sources'),
    );
    expect(sourceCreateRoute).toBeDefined();
    const deniedEvent = await registerKnowledgeModels(mongo)
      .KnowledgeAuditEvent.findOne({
        workspaceId,
        action: `${sourceCreateRoute!.operationId}.denied`,
        outcome: 'denied',
      })
      .sort({ occurredAt: -1 })
      .lean();
    expect(deniedEvent).toMatchObject({
      action: `${sourceCreateRoute!.operationId}.denied`,
      outcome: 'denied',
      safeDiff: {
        reason: 'scope',
        missingScopes: expect.arrayContaining(['knowledge:write']),
      },
    });
    expect(JSON.stringify(deniedEvent)).not.toContain(readKey.secret);

    const allowedSpaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: adminToken,
      workspaceId,
      suffix: `${suffix}-space-allowed`,
    });
    const deniedSpaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: adminToken,
      workspaceId,
      suffix: `${suffix}-space-denied`,
    });
    const spaceScopedKey = await createKey({
      label: 'space-scoped',
      scopes: ['knowledge:read', 'knowledge:write'],
      spaceIds: [allowedSpaceId],
    });
    expect(
      (await request(`/v1/knowledge/spaces/${allowedSpaceId}`, { token: spaceScopedKey.secret }))
        .response.status,
    ).toBe(200);
    expect(
      (await request(`/v1/knowledge/spaces/${deniedSpaceId}`, { token: spaceScopedKey.secret }))
        .response.status,
    ).toBe(403);
    const deniedSource = await request(`/v1/knowledge/spaces/${deniedSpaceId}/sources`, {
      method: 'POST',
      token: spaceScopedKey.secret,
      idempotencyKey: `b19-space-denied-${suffix}`,
      body: { kind: 'text', name: 'space denied', searchEnabled: true, metadata: {} },
    });
    expect(deniedSource.response.status).toBe(403);
    expect(
      await registerKnowledgeModels(mongo).KnowledgeSource.countDocuments({
        workspaceId,
        knowledgeSpaceId: deniedSpaceId,
      }),
    ).toBe(0);

    expect(
      [401, 403].includes(
        (
          await request(`/v1/knowledge/spaces/${allowedSpaceId}`, {
            token: spaceScopedKey.secret,
            workspace: `${runId}-workspace-other`,
          })
        ).response.status,
      ),
    ).toBe(true);
    expect(
      (
        await request('/v1/knowledge/spaces', {
          token: `kn_live_${'x'.repeat(10_000)}`,
        })
      ).response.status,
    ).toBe(401);

    const restrictedAdmin = await createKey({
      label: 'restricted-admin',
      scopes: ['knowledge:admin'],
      spaceIds: [allowedSpaceId],
    });
    const restrictedGlobal = await request('/v1/knowledge/usage', {
      token: restrictedAdmin.secret,
    });
    expect(restrictedGlobal.response.status).toBe(403);
    expect(restrictedGlobal.payload).toMatchObject({
      error: { code: 'KNOWLEDGE_FORBIDDEN' },
    });
  });
});

describe('L1-B19-API-001 operation auth and scope matrix', () => {
  it('L1-B19-API-001-N01 rejects unknown routes and malformed requests with stable Problems', async () => {
    const unknown = await request('/v1/knowledge/not-a-real-route');
    expect(unknown.response.status).toBe(404);
    expect(unknown.payload).toMatchObject({
      success: false,
      error: { code: 'KNOWLEDGE_NOT_FOUND' },
    });

    const invalidJson = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `b19-invalid-json-${suffix}`,
      rawBody: '{"name":',
    });
    expect(invalidJson.response.status).toBe(400);
    expect(invalidJson.payload).toMatchObject({
      success: false,
      error: { code: 'KNOWLEDGE_VALIDATION_FAILED' },
    });

    const wrongContentType = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `b19-wrong-content-type-${suffix}`,
      rawBody: '{}',
      contentType: 'text/plain',
    });
    expect(wrongContentType.response.status).toBe(400);

    const missingRequired = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `b19-missing-required-${suffix}`,
      body: { scopes: ['knowledge:read'], spaceIds: [] },
    });
    expect(missingRequired.response.status).toBe(400);

    const missingIdempotency = await request('/v1/knowledge/api-keys', {
      method: 'POST',
      body: { name: `No idempotency ${suffix}`, scopes: ['knowledge:read'], spaceIds: [] },
    });
    expect(missingIdempotency.response.status).toBe(400);

    const invalidPath = await request('/v1/knowledge/spaces/not-an-object-id');
    expect(invalidPath.response.status).toBe(400);

    const missingPath = await request('/v1/knowledge/spaces/65f1e5b2a1c9d4b7e8f09999');
    expect(missingPath.response.status).toBe(404);
  });

  it('L1-B19-API-001-A01 every runtime operation denies a missing credential except the public OpenAPI operation', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const route of RUNTIME_ROUTE_REGISTRY) {
      const result = await request(concretePath(route.path), {
        method: route.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        token: null,
        requestId: `b19-unauth-${route.operationId}-${suffix}`,
      });
      const expected = isPublicOperation(route.operationId) ? 200 : 401;
      rows.push({
        operationId: route.operationId,
        group: route.group,
        method: route.method,
        path: route.path,
        scopes: route.scopes,
        expectedStatus: expected,
        actualStatus: result.response.status,
        problemCode:
          result.payload && typeof result.payload === 'object' && 'error' in result.payload
            ? (result.payload as ApiProblem).error.code
            : null,
      });
    }
    writeEvidence('api-001-unauthenticated-matrix.json', {
      candidateSha: process.env.B19_CANDIDATE_SHA,
      rows,
    });
    expect(rows.filter((row) => row.actualStatus !== row.expectedStatus)).toEqual([]);
  });

  it('L1-B19-API-001-A02 every non-public runtime operation rejects a subject with no scope', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const route of RUNTIME_ROUTE_REGISTRY) {
      const result = await request(concretePath(route.path), {
        method: route.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        token: noScopeToken,
        baseUrl: noScopeApp.baseUrl,
        requestId: `b19-noscope-${route.operationId}-${suffix}`,
      });
      const expected = isPublicOperation(route.operationId) ? 200 : 403;
      rows.push({
        operationId: route.operationId,
        group: route.group,
        method: route.method,
        path: route.path,
        scopes: route.scopes,
        expectedStatus: expected,
        actualStatus: result.response.status,
        problemCode:
          result.payload && typeof result.payload === 'object' && 'error' in result.payload
            ? (result.payload as ApiProblem).error.code
            : null,
      });
    }
    writeEvidence('api-001-wrong-scope-matrix.json', {
      candidateSha: process.env.B19_CANDIDATE_SHA,
      rows,
    });
    expect(rows.filter((row) => row.actualStatus !== row.expectedStatus)).toEqual([]);
  });
});

describe('L1-B19-API-003 rate limiting and audit', () => {
  it('L1-B19-API-003-F01 returns frozen RateLimit and Retry-After semantics and isolates operation buckets', async () => {
    await redis.del(
      prefixedRedisKey(
        process.env.KB_REDIS_PREFIX ?? '',
        `kb-rate:${workspaceId}:API-APIKEY-ROTATE`,
      ),
    );
    const deniedAuditBefore = await registerKnowledgeModels(
      mongo,
    ).KnowledgeAuditEvent.countDocuments({
      workspaceId,
      outcome: { $in: ['denied', 'restricted'] },
    });
    const responses = await Promise.all(
      Array.from({ length: 45 }, (_, index) =>
        request(`/v1/knowledge/api-keys/65f1e5b2a1c9d4b7e8f01234/rotate`, {
          method: 'POST',
          idempotencyKey: `b19-rate-${suffix}-${index}`,
          requestId: `b19-rate-${suffix}-${index}`,
          body: { version: 1 },
        }),
      ),
    );
    const limited = responses.filter((result) => result.response.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    for (const result of responses) {
      expect(result.response.headers.get('ratelimit-limit')).toBe('30');
      expect(Number(result.response.headers.get('ratelimit-remaining'))).toBeGreaterThanOrEqual(0);
      expect(Number(result.response.headers.get('ratelimit-reset'))).toBeGreaterThanOrEqual(1);
    }
    for (const result of limited) {
      expect(Number(result.response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(result.payload).toMatchObject({
        success: false,
        error: {
          code: 'KNOWLEDGE_RATE_LIMITED',
          retryable: true,
        },
      });
      expect((result.payload as { requestId?: string }).requestId).toBeTruthy();
      expect((result.payload as { traceId?: string }).traceId).toBeTruthy();
    }
    const deniedAuditAfter = await registerKnowledgeModels(
      mongo,
    ).KnowledgeAuditEvent.countDocuments({
      workspaceId,
      outcome: { $in: ['denied', 'restricted'] },
    });
    expect(deniedAuditAfter).toBe(deniedAuditBefore + limited.length);
    const rateLimitAudits = await registerKnowledgeModels(mongo)
      .KnowledgeAuditEvent.find({
        workspaceId,
        action: 'API-APIKEY-ROTATE.denied',
        outcome: 'denied',
        'safeDiff.reason': 'rate_limit',
      })
      .lean();
    const limitedRequestIds = limited
      .map((result) => (result.payload as { requestId?: string }).requestId)
      .filter((requestId): requestId is string => Boolean(requestId))
      .sort();
    const auditedRequestIds = rateLimitAudits
      .map((event) => event.requestId)
      .filter((requestId): requestId is string => Boolean(requestId))
      .sort();
    writeEvidence('api-003-rate-limit-audit.json', {
      limitedRequestIds,
      auditedRequestIds,
      auditCount: rateLimitAudits.length,
      limitedCount: limited.length,
    });
    expect(auditedRequestIds).toEqual(limitedRequestIds);
    expect(new Set(auditedRequestIds).size).toBe(rateLimitAudits.length);
    expect(rateLimitAudits.every((event) => event.safeDiff.reason === 'rate_limit')).toBe(true);
    const otherOperation = await request('/v1/knowledge/api-keys?limit=1');
    expect(otherOperation.response.headers.get('ratelimit-limit')).toBe('100');
  });

  it('L1-B19-API-003-S02 lifecycle audit actions use safe diffs and request correlation', async () => {
    for (const action of ['api_key.create', 'api_key.update', 'api_key.rotate', 'api_key.revoke']) {
      const audit = await request(`/v1/knowledge/audit-events?action=${action}&limit=200`);
      expect(audit.response.status).toBe(200);
      const items = (audit.payload as { data: { items: Array<Record<string, unknown>> } }).data
        .items;
      expect(items.length, action).toBeGreaterThan(0);
      const serialized = JSON.stringify(items);
      expect(serialized).not.toMatch(/kn_live_[A-Za-z0-9_-]{24,}/);
      expect(serialized).not.toContain('secretHash');
      expect(serialized).not.toContain('203.0.113.19');
      for (const item of items) {
        expect(item).toMatchObject({
          action,
          requestId: expect.any(String),
          traceId: expect.any(String),
          occurredAt: expect.any(String),
          safeDiff: expect.any(Object),
        });
      }
    }
  });
});

describe('L1-B19-OPS-001 usage, quota snapshot and resource counts over real HTTP', () => {
  it('L1-B19-OPS-001-P01 reconciles usage events, resource counts and stable period errors', async () => {
    const spaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: adminToken,
      workspaceId,
      suffix: `${suffix}-ops-summary`,
    });
    const objectSpaceId = spaceId;
    const models = registerKnowledgeModels(mongo);
    const now = new Date();
    const units = [
      'page',
      'image',
      'token',
      'vector',
      'byte',
      'request',
      'second',
      'character',
    ] as const;
    await models.KnowledgeUsageEvent.create(
      units.map((unit, index) => ({
        workspaceId,
        knowledgeSpaceId: objectSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: memberId,
        updatedByMemberId: memberId,
        eventId: `${runId}-usage-${unit}`,
        eventType: index === 0 ? 'ocr' : 'storage',
        quantity: index + 1,
        unit,
        inputTokens: 0,
        outputTokens: 0,
        pointsMicros: index + 1,
        pricingVersion: 'fixture-v1',
        pricingSnapshot: { name: 'fixture-v1' },
        modelId: null,
        resourceType: 'space',
        resourceId: objectSpaceId,
        jobId: null,
        source: 'api',
        occurredAt: new Date(now.getTime() + index),
        deliveredAt: null,
        deliveryStatus: 'pending',
        expiresAt: new Date(now.getTime() + 730 * 86_400_000),
      })),
    );
    await models.KnowledgeObjectRef.create([
      {
        workspaceId,
        knowledgeSpaceId: objectSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: memberId,
        updatedByMemberId: memberId,
        provider: 'minio',
        bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
        objectKey: `b19-a/${runId}/fixtures/object-a`,
        purpose: 'source',
        mimeType: 'text/plain',
        sizeBytes: 40,
        state: 'active',
        upload: {
          mode: 'single',
          status: 'completed',
          originalName: 'object-a.txt',
        },
      },
      {
        workspaceId,
        knowledgeSpaceId: objectSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: memberId,
        updatedByMemberId: memberId,
        provider: 'minio',
        bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
        objectKey: `b19-a/${runId}/fixtures/object-b`,
        purpose: 'source',
        mimeType: 'text/plain',
        sizeBytes: 60,
        state: 'pending',
        upload: {
          mode: 'single',
          status: 'uploading',
          originalName: 'object-b.txt',
        },
      },
    ]);
    const sourceId = randomUUID().replaceAll('-', '').slice(0, 24);
    await models.KnowledgeSegment.create([
      {
        workspaceId,
        knowledgeSpaceId: objectSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: memberId,
        updatedByMemberId: memberId,
        sourceId,
        sourceVersion: 1,
        searchEnabled: true,
        order: 0,
        content: 'B19 OPS fixture content',
        fullTextVersion: 1,
        metadata: {},
        history: [],
        indexStatus: 'indexed',
        indexes: [
          [768, 'vector'],
          [1024, 'vector'],
          [1536, 'vector'],
          [3072, 'halfvec'],
        ].map(([dimension, storageType], index) => ({
          indexId: `${runId}-index-${dimension}`,
          type: 'embedding',
          modelId: `b19-embedding-${dimension}`,
          dimension,
          storageType,
          vectorProfile: `${dimension}-${storageType}`,
          vectorId: `${runId}-vector-${index}`,
          text: `vector ${dimension}`,
          version: 1,
        })),
      },
    ]);

    const from = new Date(now.getTime() - 60_000).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();
    const summaryResponse = await request(
      `/v1/knowledge/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&spaceId=${spaceId}`,
    );
    expect(summaryResponse.response.status, JSON.stringify(summaryResponse.payload)).toBe(200);
    const summary = summaryResponse.payload as {
      data: {
        usage: Record<string, number>;
        delivery: Record<string, number>;
        quota: Record<string, number | string>;
      };
    };
    expect(summary.data.usage).toMatchObject({
      aiPointsMicros: 36,
      aiPoints: 0.000036,
      storageBytes: 100,
      indexCount: 4,
      spaceCount: 1,
      parsePages: 1,
    });
    expect(summary.data.delivery).toEqual({ pending: 8, delivered: 0, failed: 0 });
    expect(summary.data.quota).toMatchObject({
      maxSpaces: 3,
      maxModelConcurrency: 10,
    });
    expect(Number(summary.data.quota.aiPointsLimit)).toBeGreaterThanOrEqual(100);
    expect(Number(summary.data.quota.maxIndexes)).toBeGreaterThanOrEqual(600);
    expect(Number(summary.data.quota.requestsPerMinute)).toBeGreaterThanOrEqual(30);

    const reversed = await request(
      `/v1/knowledge/usage?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`,
    );
    expect(reversed.response.status).toBe(400);
    expect(reversed.payload).toMatchObject({
      error: { code: 'KNOWLEDGE_VALIDATION_FAILED' },
    });
    const tooWideFrom = new Date(Date.now() - 367 * 86_400_000).toISOString();
    const tooWide = await request(
      `/v1/knowledge/usage?from=${encodeURIComponent(tooWideFrom)}&to=${encodeURIComponent(new Date().toISOString())}`,
    );
    expect(tooWide.response.status).toBe(400);
    expect(tooWide.payload).toMatchObject({
      error: { code: 'KNOWLEDGE_VALIDATION_FAILED' },
    });

    const crossWorkspace = await request('/v1/knowledge/usage', {
      workspace: `${runId}-workspace-other`,
    });
    expect(crossWorkspace.response.status).toBe(403);
    const status = await request('/v1/knowledge/operations/status');
    expect(status.response.status, JSON.stringify(status.payload)).toBe(200);
    expect(status.payload).toMatchObject({
      success: true,
      data: {
        securityChecks: {
          apiKeyHmacConfigured: true,
          scopeEnforced: true,
          auditAppendOnly: true,
          secretRedactionEnabled: true,
          rateLimitEnabled: true,
        },
      },
    });
    writeEvidence('ops-001-resource-reconciliation.json', {
      candidateSha: process.env.B19_CANDIDATE_SHA,
      runId,
      spaceId,
      units,
      expected: {
        aiPointsMicros: 36,
        storageBytes: 100,
        indexCount: 4,
        spaceCount: 1,
        parsePages: 1,
        delivery: { pending: 8, delivered: 0, failed: 0 },
        vectorProfiles: [768, 1024, 1536, 3072],
      },
      actual: {
        usage: summary.data.usage,
        quota: summary.data.quota,
        delivery: summary.data.delivery,
      },
      periodErrors: {
        reversed: reversed.response.status,
        over366Days: tooWide.response.status,
      },
      crossWorkspaceStatus: crossWorkspace.response.status,
      operationsStatus: status.response.status,
    });
  });
});
