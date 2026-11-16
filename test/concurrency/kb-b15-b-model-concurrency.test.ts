import { describe, expect, it } from 'vitest';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5KeyedLimiterPort,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import { usageEventIdOf } from '../../packages/service/src/modules/knowledge/repository/s5-usage.repository';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const workspaces = ['ws-b15-concurrency-a', 'ws-b15-concurrency-b'] as const;

function contextOf(workspaceId: string): TenantContext {
  return {
    workspaceId,
    memberId: `member-${workspaceId}`,
    requestId: `request-${workspaceId}`,
    traceId: `trace-${workspaceId}`,
    scopes: ['knowledge:write', 'knowledge:search'],
  };
}

const catalogModels: ModelCatalogItem[] = [
  {
    modelId: 'llm-shared',
    displayName: 'Shared LLM',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
];

const catalog: ModelCatalogPort = {
  async listModels() {
    return catalogModels;
  },
};

class NoopUsage implements S5UsageRecorderPort {
  async recordInvocationUsage(_fact: S5GatewayUsageFact) {
    return true;
  }
}

class KeyedLimiter implements S5KeyedLimiterPort {
  readonly keys: string[] = [];
  readonly active = new Map<string, number>();
  readonly maxActive = new Map<string, number>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    const active = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, active);
    this.maxActive.set(key, Math.max(this.maxActive.get(key) ?? 0, active));
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await work();
    } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
    }
  }
}

describe('L1-B15-B MODEL-006 workspace concurrency and usage identity', () => {
  it('L1-B15-B-MODEL-006-C01 uses workspace-scoped limiter keys and prevents cross-workspace serialization', async () => {
    const limiter = new KeyedLimiter();
    const gateway = new S5ModelGateway({
      catalog,
      usage: new NoopUsage(),
      limiter,
      adapter: {
        async invoke<T>() {
          return {
            data: { choices: [{ message: { content: 'ok' } }] } as T,
            status: 200,
            quantity: 1,
            usage: { inputTokens: 1, outputTokens: 0 },
          };
        },
      },
    });

    const requests = workspaces.flatMap((workspaceId) =>
      Array.from({ length: 10 }, (_, index) => {
        const context = contextOf(workspaceId);
        return gateway.invoke({
          kind: 'llm',
          modelId: 'llm-shared',
          messages: [{ role: 'user', content: `${workspaceId}-${index}` }],
          maxOutputTokens: 8,
          workspaceId,
          knowledgeSpaceId: `65f1e5b2a1c9d4b7e8f0${index.toString().padStart(4, '0')}`,
          requestId: `request-${workspaceId}-${index}`,
          traceId: `trace-${workspaceId}-${index}`,
          context,
        });
      }),
    );
    await Promise.all(requests);

    expect(new Set(limiter.keys)).toEqual(new Set(workspaces));
    expect(limiter.maxActive.get(workspaces[0])).toBeGreaterThan(1);
    expect(limiter.maxActive.get(workspaces[1])).toBeGreaterThan(1);
    expect(limiter.active.get(workspaces[0])).toBe(0);
    expect(limiter.active.get(workspaces[1])).toBe(0);
  });

  it('L1-B15-B-MODEL-006-C02 scopes usage event IDs by workspace and attempt', () => {
    const base = {
      workspaceId: workspaces[0],
      operation: 'search:rerank',
      requestId: 'request-shared',
      modelId: 'rerank-primary',
      kind: 'rerank',
      attempt: 1,
      eventSequence: 2,
    };
    const first = usageEventIdOf(base);
    expect(usageEventIdOf({ ...base })).toBe(first);
    expect(usageEventIdOf({ ...base, workspaceId: workspaces[1] })).not.toBe(first);
    expect(usageEventIdOf({ ...base, attempt: 2 })).not.toBe(first);
    expect(usageEventIdOf({ ...base, requestId: 'request-other' })).not.toBe(first);
  });

  it('L1-B15-B-MODEL-006-C03 keeps identical query results associated with their own request IDs', async () => {
    const gateway = new S5ModelGateway({
      catalog,
      usage: new NoopUsage(),
      adapter: {
        async invoke<T>(request) {
          return {
            data: {
              choices: [{ message: { content: `result:${request.requestId}` } }],
            } as T,
            status: 200,
            quantity: 1,
            usage: { inputTokens: 1, outputTokens: 0 },
          };
        },
      },
    });
    const context = contextOf(workspaces[0]);
    const [left, right] = await Promise.all(
      ['left', 'right'].map((requestId) =>
        gateway.invoke({
          kind: 'llm',
          modelId: 'llm-shared',
          messages: [{ role: 'user', content: 'same query' }],
          maxOutputTokens: 8,
          workspaceId: context.workspaceId,
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
          requestId,
          traceId: `trace-${requestId}`,
          context,
        }),
      ),
    );

    expect(left.data).toEqual({ choices: [{ message: { content: 'result:left' } }] });
    expect(right.data).toEqual({ choices: [{ message: { content: 'result:right' } }] });
  });
});
