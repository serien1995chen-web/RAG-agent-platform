import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge';
import type { AccessPort } from '../../src/modules/knowledge/application/ports';
import { S5ModelBindingApplication } from '../../src/modules/knowledge/application/s5-model-binding.application';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S5ModelBindingRepository } from '../../src/modules/knowledge/repository/s5-model-binding.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s5_binding_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s5_binding_${suffix}`,
  requestId: `req_s5_binding_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

const access = {
  async assertPermission() {
    return undefined;
  },
} as unknown as AccessPort;

let connection: mongoose.Connection;
let application: S5ModelBindingApplication;
let catalog: KnowledgeCatalogRepository;

function bindings() {
  return [
    {
      modelType: 'llm',
      modelId: 'mock-llm-general',
      displayName: 'Mock general LLM',
      requiredCapabilities: ['chat'],
      status: 'active',
    },
    {
      modelType: 'embedding',
      modelId: 'mock-embedding-1024',
      displayName: 'Mock embedding 1024',
      requiredCapabilities: ['text-embedding', 'dimension:1024'],
      status: 'active',
    },
    {
      modelType: 'rerank',
      modelId: 'mock-rerank',
      displayName: 'Mock rerank',
      requiredCapabilities: ['rerank'],
      status: 'active',
    },
    {
      modelType: 'vlm',
      modelId: 'mock-vlm',
      displayName: 'Mock vision model',
      requiredCapabilities: ['vision'],
      status: 'active',
    },
    {
      modelType: 'stt',
      modelId: 'mock-stt',
      displayName: 'Mock speech recognition',
      requiredCapabilities: ['speech-to-text'],
      status: 'active',
    },
    {
      modelType: 'tts',
      modelId: 'mock-tts',
      displayName: 'Mock speech synthesis',
      requiredCapabilities: ['text-to-speech'],
      status: 'active',
    },
  ];
}

async function createSpace(name: string) {
  return catalog.createSpace(
    {
      kind: 'space',
      name,
      accessMode: 'workspace',
      sourceAclMode: 'enforced',
      sourcePermissionEnabled: true,
    },
    context,
  );
}

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_bindings');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  catalog = new KnowledgeCatalogRepository(connection);
  application = new S5ModelBindingApplication(
    new S5ModelBindingRepository(connection),
    new S5MockModelCatalog(),
    access,
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-KB-002-BLOCK Space model bindings', () => {
  it('atomically replaces zero through six bindings and mirrors Space state', async () => {
    const space = await createSpace(`Bindings ${suffix}`);
    const updated = await application.dispatch({
      operationId: 'API-MODEL-BINDING-UPDATE',
      params: { spaceId: space.id },
      query: {},
      body: { bindings: bindings(), version: space.version },
      context,
    });
    expect(updated).toMatchObject({
      status: 200,
      data: { version: space.version + 1 },
    });
    expect((updated.data as { items: unknown[] }).items).toHaveLength(6);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeModelBinding.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    ).toBe(6);
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(1);
    const storedSpace = await models.KnowledgeSpace.findById(space.id).lean();
    expect(Object.keys(storedSpace?.modelBindings ?? {}).sort()).toEqual([
      'embedding',
      'llm',
      'rerank',
      'stt',
      'tts',
      'vlm',
    ]);

    const cleared = await application.dispatch({
      operationId: 'API-MODEL-BINDING-UPDATE',
      params: { spaceId: space.id },
      query: {},
      body: { bindings: [], version: space.version + 1 },
      context,
    });
    expect(cleared).toMatchObject({
      status: 200,
      data: { items: [], version: space.version + 2 },
    });
    expect(
      await models.KnowledgeModelBinding.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    ).toBe(0);
  });

  it('rejects invalid capability before the transaction and leaves all state unchanged', async () => {
    const space = await createSpace(`Invalid ${suffix}`);
    const invalid = bindings();
    invalid[1] = {
      ...invalid[1]!,
      requiredCapabilities: ['dimension:3072'],
    };
    await expect(
      application.dispatch({
        operationId: 'API-MODEL-BINDING-UPDATE',
        params: { spaceId: space.id },
        query: {},
        body: { bindings: invalid, version: space.version },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeModelBinding.countDocuments({ workspaceId })).toBe(0);
    expect((await models.KnowledgeSpace.findById(space.id).lean())?.version).toBe(space.version);
  });

  it('returns conflict for stale Space versions', async () => {
    const space = await createSpace(`Conflict ${suffix}`);
    await application.dispatch({
      operationId: 'API-MODEL-BINDING-UPDATE',
      params: { spaceId: space.id },
      query: {},
      body: { bindings: [], version: space.version },
      context,
    });
    await expect(
      application.dispatch({
        operationId: 'API-MODEL-BINDING-UPDATE',
        params: { spaceId: space.id },
        query: {},
        body: { bindings: [], version: space.version },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });

  it('returns a deterministic binding order and does not leak another workspace', async () => {
    const space = await createSpace(`Read ${suffix}`);
    await application.dispatch({
      operationId: 'API-MODEL-BINDING-UPDATE',
      params: { spaceId: space.id },
      query: {},
      body: { bindings: bindings(), version: space.version },
      context,
    });
    const read = await application.dispatch({
      operationId: 'API-MODEL-BINDING-GET',
      params: { spaceId: space.id },
      query: {},
      body: {},
      context,
    });
    expect(
      (read.data as { items: Array<{ modelType: string }> }).items.map((item) => item.modelType),
    ).toEqual(['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts']);
    const other = await new S5ModelBindingRepository(connection)
      .list(space.id, { ...context, workspaceId: `other_${suffix}`, memberId: 'other' })
      .catch((error) => error);
    expect(other).toEqual([]);
  });
});
