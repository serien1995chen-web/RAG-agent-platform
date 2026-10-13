import { describe, expect, it, vi } from 'vitest';
import type { ModelSelection } from '../../../contracts/src/index';
import { createModelRegistryAdapter } from '../../src/modules/index/adapter/model-registry.adapter';
import { QueryExtensionService } from '../../src/modules/index/application/query-extension.service';
import type { PortCallOptions, RequestContext } from '../../src/ports/types';

const options: PortCallOptions = { timeoutMs: 1_000 };

function contextFor(teamId = 'team-a', requestId = 'req-model'): RequestContext {
  return {
    requestId,
    tenant: { teamId, tmbId: 'tmb-a', authType: 'token', isRoot: false },
    permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
  };
}

const models: ModelSelection[] = [
  { embeddingModel: 'bge-m3', llmModel: 'gpt-x', vlmModel: 'vlm-x', rerankModel: 'rerank-x' },
];

describe('P5-03 model capability registry', () => {
  it('TEST-MODEL-MOCK-001 / ACC-DEP-005: probes and filters capabilities in mock mode', async () => {
    const adapter = createModelRegistryAdapter({
      environment: 'test',
      mockMode: 'mock',
      models,
    });
    const context = contextFor();

    const capability = await adapter.getCapability({ modelId: 'bge-m3', options }, context);
    expect(capability).toEqual({ modelId: 'bge-m3', dimension: 1536, capabilities: ['embedding'] });

    const embedding = await adapter.listModels({ capability: 'embedding', options }, context);
    expect(embedding).toHaveLength(1);
    const rerank = await adapter.listModels({ capability: 'rerank', options }, context);
    expect(rerank).toEqual(models);
    const missing = await adapter.listModels({ capability: 'unknown', options }, context);
    expect(missing).toEqual([]);
  });

  it('TEST-PROVIDER-MATRIX-001: caches capability by modelId+capability but not permission', async () => {
    const probe = vi.fn(async () => ({ dimension: 1536, capabilities: ['embedding'] }));
    const adapter = createModelRegistryAdapter({
      environment: 'test',
      mockMode: 'mock',
      models,
      gateway: { probe },
    });

    await adapter.getCapability({ modelId: 'bge-m3', options }, contextFor('team-a'));
    await adapter.getCapability({ modelId: 'bge-m3', options }, contextFor('team-b'));
    expect(probe).toHaveBeenCalledTimes(1);

    await adapter.probe({ modelId: 'bge-m3', options }, contextFor('team-a'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('TEST-PROVIDER-MATRIX-001: rejects embedding dimension 1535/1537 with 501013', async () => {
    const adapterFor = (dimension: number) =>
      createModelRegistryAdapter({
        environment: 'test',
        mockMode: 'mock',
        models,
        gateway: { probe: async () => ({ dimension, capabilities: ['embedding'] }) },
      });

    await expect(
      adapterFor(1535).getCapability({ modelId: 'bge-m3', options }, contextFor()),
    ).rejects.toMatchObject({ error: { code: 501013 } });
    await expect(
      adapterFor(1537).getCapability({ modelId: 'bge-m3', options }, contextFor()),
    ).rejects.toMatchObject({ error: { code: 501013 } });
  });

  it('ACC-DEP-005: returns 501062 when the dependency is unconfigured', async () => {
    const adapter = createModelRegistryAdapter({
      environment: 'test',
      mockMode: 'mock',
      models: [],
    });
    await expect(
      adapter.getCapability({ modelId: 'bge-m3', options }, contextFor()),
    ).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('U-25: production traffic hitting mock mode returns 501063', async () => {
    const adapter = createModelRegistryAdapter({
      environment: 'production',
      mockMode: 'mock',
      models,
    });
    await expect(
      adapter.listModels({ capability: 'embedding', options }, contextFor()),
    ).rejects.toMatchObject({ error: { code: 501063 } });
  });
});

describe('P5-03 query extension', () => {
  it('ACC-EXT-002: failures fall back to the original query without widening filters', async () => {
    const service = new QueryExtensionService({
      model: 'llm-x',
      gateway: {
        extend: async () => {
          throw new Error('extension_timeout');
        },
      },
    });

    const result = await service.extend({ query: '原问题', histories: ['历史'] }, contextFor());
    expect(result.query).toBe('原问题');
    expect(result.degraded).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['degraded', 'query', 'reason']);

    const unconfigured = new QueryExtensionService({});
    const fallback = await unconfigured.extend({ query: '原问题' }, contextFor());
    expect(fallback.query).toBe('原问题');
    expect(fallback.degraded).toBe(true);
  });

  it('ACC-EXT-002: returns the extended query when the gateway succeeds', async () => {
    const service = new QueryExtensionService({
      model: 'llm-x',
      gateway: { extend: async () => ({ query: '扩展问题' }) },
    });
    const result = await service.extend({ query: '原问题' }, contextFor());
    expect(result).toEqual({ query: '扩展问题', degraded: false });
  });
});
