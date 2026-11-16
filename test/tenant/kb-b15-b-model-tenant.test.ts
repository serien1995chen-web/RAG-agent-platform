import { describe, expect, it, vi } from 'vitest';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const contextA: TenantContext = {
  workspaceId: 'ws-b15-a',
  memberId: 'mem-b15-a',
  requestId: 'req-b15-a',
  traceId: 'trace-b15-a',
  scopes: ['knowledge:write', 'knowledge:search'],
};

const contextB: TenantContext = {
  workspaceId: 'ws-b15-b',
  memberId: 'mem-b15-b',
  requestId: 'req-b15-b',
  traceId: 'trace-b15-b',
  scopes: ['knowledge:write', 'knowledge:search'],
};

const modelsByWorkspace: Record<string, ModelCatalogItem[]> = {
  [contextA.workspaceId]: [
    {
      modelId: 'llm-a-primary',
      displayName: 'Tenant A primary',
      type: 'llm',
      capabilities: ['chat'],
      dimension: null,
      authorized: true,
    },
    {
      modelId: 'llm-a-fallback',
      displayName: 'Tenant A fallback',
      type: 'llm',
      capabilities: ['chat'],
      dimension: null,
      authorized: true,
    },
    {
      modelId: 'llm-a-revoked',
      displayName: 'Tenant A revoked',
      type: 'llm',
      capabilities: ['chat'],
      dimension: null,
      authorized: false,
    },
  ],
  [contextB.workspaceId]: [
    {
      modelId: 'llm-b-primary',
      displayName: 'Tenant B primary',
      type: 'llm',
      capabilities: ['chat'],
      dimension: null,
      authorized: true,
    },
  ],
};

class Usage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  async recordInvocationUsage(fact: S5GatewayUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

describe('L1-B15-B MODEL-003/004/006 tenant isolation', () => {
  it('L1-B15-B-MODEL-006-A01 resolves the catalog with the requesting workspace only', async () => {
    const listModels = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      return modelsByWorkspace[workspaceId] ?? [];
    });
    const catalog: ModelCatalogPort = { listModels };
    const adapter = {
      async invoke<T>(request: { modelId: string }) {
        return {
          data: { choices: [{ message: { content: request.modelId } }] } as T,
          status: 200,
          quantity: 1,
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    };
    const gateway = new S5ModelGateway({ catalog, adapter, usage: new Usage() });

    const resultA = await gateway.invoke({
      kind: 'llm',
      modelId: 'llm-a-primary',
      messages: [],
      maxOutputTokens: 8,
      workspaceId: contextA.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      requestId: contextA.requestId,
      traceId: contextA.traceId,
      context: contextA,
    });
    const resultB = await gateway.invoke({
      kind: 'llm',
      modelId: 'llm-b-primary',
      messages: [],
      maxOutputTokens: 8,
      workspaceId: contextB.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01235',
      requestId: contextB.requestId,
      traceId: contextB.traceId,
      context: contextB,
    });

    expect(resultA.actualModelId).toBe('llm-a-primary');
    expect(resultB.actualModelId).toBe('llm-b-primary');
    expect(listModels.mock.calls.map(([input]) => input.workspaceId)).toEqual([
      contextA.workspaceId,
      contextB.workspaceId,
    ]);
  });

  it('L1-B15-B-MODEL-006-A02 rejects another workspace model before external invocation', async () => {
    const listModels = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      return modelsByWorkspace[workspaceId] ?? [];
    });
    const invoke = vi.fn();
    const gateway = new S5ModelGateway({
      catalog: { listModels },
      adapter: { invoke },
      usage: new Usage(),
    });

    await expect(
      gateway.invoke({
        kind: 'llm',
        modelId: 'llm-b-primary',
        messages: [],
        maxOutputTokens: 8,
        workspaceId: contextA.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: contextA.requestId,
        traceId: contextA.traceId,
        context: contextA,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: {
            field: 'modelId',
            reason: 'not_authorized_for_type',
          },
        },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('L1-B15-B-MODEL-006-A03 skips revoked fallback grants without issuing a provider request', async () => {
    const calls: string[] = [];
    const gateway = new S5ModelGateway({
      catalog: {
        async listModels({ workspaceId }) {
          return modelsByWorkspace[workspaceId] ?? [];
        },
      },
      usage: new Usage(),
      sleep: async () => undefined,
      adapter: {
        async invoke<T>(request) {
          calls.push(request.modelId);
          if (request.modelId === 'llm-a-primary') {
            const { S5ModelTransportError } =
              await import('../../packages/service/src/modules/knowledge/application/s5-model-gateway.port');
            throw new S5ModelTransportError('provider', 503);
          }
          return {
            data: { choices: [{ message: { content: 'fallback' } }] } as T,
            status: 200,
            quantity: 1,
            usage: { inputTokens: 1, outputTokens: 0 },
          };
        },
      },
    });

    await expect(
      gateway.invoke({
        kind: 'llm',
        modelId: 'llm-a-primary',
        messages: [],
        maxOutputTokens: 8,
        workspaceId: contextA.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: contextA.requestId,
        traceId: contextA.traceId,
        context: contextA,
        fallbackModelIds: ['llm-a-revoked', 'llm-a-fallback'],
      }),
    ).resolves.toMatchObject({ actualModelId: 'llm-a-fallback' });
    expect(calls).toEqual(['llm-a-primary', 'llm-a-fallback']);
    expect(calls).not.toContain('llm-a-revoked');
  });

  it('L1-B15-B-MODEL-006-A04 rejects request/context workspace mismatch before catalog access', async () => {
    const listModels = vi.fn();
    const invoke = vi.fn();
    const gateway = new S5ModelGateway({
      catalog: { listModels },
      adapter: { invoke },
      usage: new Usage(),
    });

    await expect(
      gateway.invoke({
        kind: 'llm',
        modelId: 'llm-a-primary',
        messages: [],
        maxOutputTokens: 8,
        workspaceId: contextB.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: contextA.requestId,
        traceId: contextA.traceId,
        context: contextA,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'workspaceId', reason: 'tenant_mismatch' },
        },
      },
    });
    expect(listModels).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
