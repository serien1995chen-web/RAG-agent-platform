import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../packages/service/src/modules/knowledge';
import type { AccessPort } from '../../packages/service/src/modules/knowledge/application/ports';
import { S5ModelBindingApplication } from '../../packages/service/src/modules/knowledge/application/s5-model-binding.application';
import { S5MockModelCatalog } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S5ModelBindingRepository } from '../../packages/service/src/modules/knowledge/repository/s5-model-binding.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_s5_binding_cas_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};
const access = {
  async assertPermission() {
    return undefined;
  },
} as unknown as AccessPort;

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let application: S5ModelBindingApplication;

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_binding_cas',
  );
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  catalog = new KnowledgeCatalogRepository(connection);
  application = new S5ModelBindingApplication(
    new S5ModelBindingRepository(connection),
    new S5MockModelCatalog(),
    access,
  );
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('S5 model binding CAS concurrency', () => {
  it('allows exactly one same-version replacement and rolls back the loser', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Binding CAS ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const llm = {
      modelType: 'llm',
      modelId: 'mock-llm-general',
      displayName: 'LLM',
      requiredCapabilities: ['chat'],
      status: 'active',
    };
    const stt = {
      modelType: 'stt',
      modelId: 'mock-stt',
      displayName: 'STT',
      requiredCapabilities: ['speech-to-text'],
      status: 'active',
    };
    const outcomes = await Promise.allSettled([
      application.dispatch({
        operationId: 'API-MODEL-BINDING-UPDATE',
        params: { spaceId: space.id },
        query: {},
        body: { bindings: [llm], version: space.version },
        context,
      }),
      application.dispatch({
        operationId: 'API-MODEL-BINDING-UPDATE',
        params: { spaceId: space.id },
        query: {},
        body: { bindings: [stt], version: space.version },
        context,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeModelBinding.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    ).toBe(1);
  });
});
