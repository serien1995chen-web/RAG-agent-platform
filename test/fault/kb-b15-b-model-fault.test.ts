import { describe, expect, it, vi } from 'vitest';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { S5ModelTransportError } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b15-fault',
  memberId: 'mem-b15-fault',
  requestId: 'req-b15-fault',
  traceId: 'trace-b15-fault',
  scopes: ['knowledge:write', 'knowledge:search'],
};

const models: ModelCatalogItem[] = [
  {
    modelId: 'llm-primary',
    displayName: 'LLM primary',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'llm-fallback',
    displayName: 'LLM fallback',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'embedding-primary',
    displayName: 'Embedding primary',
    type: 'embedding',
    capabilities: ['text-embedding', 'dimension:768'],
    dimension: 768,
    authorized: true,
  },
  {
    modelId: 'rerank-primary',
    displayName: 'Rerank primary',
    type: 'rerank',
    capabilities: ['rerank'],
    dimension: null,
    authorized: true,
  },
];

const catalog: ModelCatalogPort = {
  async listModels() {
    return models;
  },
};

class Usage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  async recordInvocationUsage(fact: S5GatewayUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'llm' as const,
    modelId: 'llm-primary',
    messages: [{ role: 'user', content: 'fault test' }],
    maxOutputTokens: 32,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
    requestId: context.requestId,
    traceId: context.traceId,
    context,
    ...overrides,
  };
}

describe('L1-B15-B MODEL-006 retry and failure taxonomy', () => {
  it.each([
    ['rate limit', 'rate_limit', 429, 'KNOWLEDGE_RATE_LIMITED'],
    ['provider 500', 'provider', 500, 'KNOWLEDGE_MODEL_FAILED'],
    ['provider 503', 'provider', 503, 'KNOWLEDGE_MODEL_FAILED'],
    ['timeout', 'timeout', null, 'KNOWLEDGE_DEPENDENCY_TIMEOUT'],
  ])(
    'L1-B15-B-MODEL-006-F02..05 retries %s with a hard three-attempt bound',
    async (_label, kind, status, code) => {
      const calls: number[] = [];
      const gateway = new S5ModelGateway({
        catalog,
        usage: new Usage(),
        sleep: async () => undefined,
        adapter: {
          async invoke() {
            calls.push(Date.now());
            throw new S5ModelTransportError(kind as never, status, null, 'safe_failure');
          },
        },
      });

      await expect(gateway.invoke(request())).rejects.toMatchObject({
        problem: {
          error: {
            code,
            retryable: true,
            details: {
              attempts: 3,
              reason: 'attempts_exhausted',
            },
          },
        },
      });
      expect(calls).toHaveLength(3);
    },
  );

  it.each([401, 403])(
    'L1-B15-B-MODEL-006-F06 HTTP %i stops authentication failure immediately without fallback',
    async (status) => {
      const invoke = vi.fn(async () => {
        throw new S5ModelTransportError('auth', status, null, 'auth_rejected');
      });
      const gateway = new S5ModelGateway({
        catalog,
        usage: new Usage(),
        adapter: { invoke },
      });

      await expect(
        gateway.invoke(request({ fallbackModelIds: ['llm-fallback'] })),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
      });
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['contract', 'validation'])(
    'L1-B15-B-MODEL-006-F07..08 does not infinitely retry %s failures',
    async (kind) => {
      const invoke = vi.fn(async () => {
        throw new S5ModelTransportError(kind as never, 200, null, 'invalid_provider_contract');
      });
      const gateway = new S5ModelGateway({
        catalog,
        usage: new Usage(),
        adapter: { invoke },
      });

      await expect(gateway.invoke(request())).rejects.toBeTruthy();
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it('L1-B15-B-MODEL-006-F09 applies bounded exponential backoff before retries', async () => {
    const delays: number[] = [];
    const gateway = new S5ModelGateway({
      catalog,
      usage: new Usage(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      adapter: {
        async invoke() {
          throw new S5ModelTransportError('provider', 503, null, 'upstream_unavailable');
        },
      },
    });

    await expect(gateway.invoke(request())).rejects.toBeTruthy();
    expect(delays).toEqual([250, 500]);
  });

  it('L1-B15-B-MODEL-006-F10 honors retry-after within the configured maximum', async () => {
    const delays: number[] = [];
    const gateway = new S5ModelGateway({
      catalog,
      usage: new Usage(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      adapter: {
        async invoke() {
          throw new S5ModelTransportError('rate_limit', 429, 900, 'rate_limited');
        },
      },
    });

    await expect(gateway.invoke(request())).rejects.toBeTruthy();
    expect(delays).toEqual([900, 900]);
  });

  it('L1-B15-B-MODEL-006-N02 does not retry an unexpected implementation error', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('unexpected implementation error');
    });
    const usage = new Usage();
    const gateway = new S5ModelGateway({ catalog, usage, adapter: { invoke } });

    await expect(gateway.invoke(request())).rejects.toThrow('unexpected implementation error');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(usage.facts).toHaveLength(2);
  });
});
