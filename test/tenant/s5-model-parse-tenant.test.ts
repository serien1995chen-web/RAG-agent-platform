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
const workspaceId = `ws_s5_tenant_${suffix}`;
const otherWorkspaceId = `ws_s5_other_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};
const access = {
  async assertPermission(
    _resourceType: string,
    _resourceId: string,
    _permission: string,
    current: TenantContext,
  ) {
    if (current.workspaceId !== workspaceId) {
      throw Object.assign(new Error('forbidden'), {
        problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
      });
    }
  },
} as unknown as AccessPort;

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let application: S5ModelBindingApplication;

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_tenant');
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
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
  await connection.close();
});

describe('TEST-X-TENANT-GUARD S5 model bindings', () => {
  it('does not expose or update a Space from another workspace', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Tenant ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const otherContext = {
      ...context,
      workspaceId: otherWorkspaceId,
      memberId: `other_${suffix}`,
    };
    await expect(
      application.dispatch({
        operationId: 'API-MODEL-BINDING-GET',
        params: { spaceId: space.id },
        query: {},
        body: {},
        context: otherContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } } });
    await expect(
      new S5ModelBindingRepository(connection).replace(space.id, space.version, [], otherContext),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(
      await registerKnowledgeModels(connection).KnowledgeModelBinding.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    ).toBe(0);
  });
});
