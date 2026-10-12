import type mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT_IDS,
  SourceProviderRegistry,
  createDefaultPorts,
} from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/index';
import { bootstrapRuntime } from '../../projects/app/src/runtime/bootstrap';
import type { AppRuntime } from '../../projects/app/src/runtime/health';
import type { RuntimeClients } from '../../projects/app/src/runtime/clients';

function fakeConnection(): mongoose.Connection {
  return {
    models: {},
    model: () => ({}),
  } as unknown as mongoose.Connection;
}

function fakeClients(): RuntimeClients {
  return {
    mongo: fakeConnection(),
    pg: { query: async () => ({ rows: [] }) },
    redis: {},
    objectStore: {},
    logger: {},
    idempotencyStore: {},
  } as unknown as RuntimeClients;
}

function fakeBaseRuntime(clients: RuntimeClients): AppRuntime {
  return {
    config: {
      role: {
        mode: 'all',
        runsHttp: true,
        runsWorker: true,
        runsChangeStream: true,
        runsScheduler: true,
      },
    },
    clients,
    health: {
      checkRequired: async () => [],
      checkOptional: async () => [],
      summarize: () => ({ httpStatus: 200, response: {} }),
    },
    extensions: {},
    datasetApi: {},
    datasetSearch: {},
    startedAt: Date.now(),
    startup: { state: 'ready', issues: [] },
  } as unknown as AppRuntime;
}

const embeddingContext: RequestContext = {
  requestId: 'req-runtime-bootstrap',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
};

describe('runtime bootstrap (P2-17)', () => {
  it('assembles real ports and shuts down drain before releasing clients', async () => {
    const events: string[] = [];
    const clients = fakeClients();
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => {
        events.push('drain');
      },
      closeClients: async () => {
        events.push('close');
      },
    });

    expect(runtime.collectionService).toBeDefined();
    expect(runtime.knowledgeItemService).toBeDefined();
    expect(runtime.processingService).toBeDefined();
    expect(typeof runtime.collectionRepository.list).toBe('function');
    expect(typeof runtime.datasetPermission.getPermission).toBe('function');
    expect(runtime.vectorController).toBeDefined();
    expect(runtime.fullTextStore).toBeDefined();
    expect(runtime.embeddingService).toBeDefined();
    expect(DEFAULT_PORT_IDS).toHaveLength(38);
    expect(DEFAULT_PORT_IDS).not.toContain('EmbeddingGateway');

    await runtime.shutdown();
    await runtime.shutdown();
    expect(events).toEqual(['drain', 'close']);
  });

  it('wires the optional embedding gateway into the embedding service', async () => {
    const clients = fakeClients();
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
      embeddingGateway: { embed: async () => [new Array<number>(1536).fill(0.5)] },
    });
    const vectors = await runtime.embeddingService.embed(
      {
        models: { embeddingModel: 'bge-m3' },
        texts: ['hello'],
        options: { timeoutMs: 1000 },
      },
      embeddingContext,
    );
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1536);
  });

  it('assembles a default SourceProviderRegistry when none is injected', async () => {
    const clients = fakeClients();
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
    });
    expect(runtime.datasetSourceProvider).toBeInstanceOf(SourceProviderRegistry);
    expect(runtime.ports.datasetSourceProvider).toBe(runtime.datasetSourceProvider);
  });

  it('registers the default file provider and parses a text file', async () => {
    const clients = fakeClients();
    clients.objectStore.get = async (input: { ref: unknown }) => ({
      ref: input.ref,
      body: Buffer.from('default file parser'),
    });
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
    });
    const result = await runtime.ports.datasetSourceProvider.read(
      {
        datasetId: 'ds-1',
        sourceType: 'file',
        sourceRef: 'temp/team-a/input.txt',
        options: { timeoutMs: 1000 },
      },
      embeddingContext,
    );
    expect(result.rawText).toBe('default file parser');
  });

  it('returns stable provider errors instead of skeleton 501999 by default', async () => {
    const clients = fakeClients();
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
    });
    await expect(
      runtime.ports.datasetSourceProvider.read(
        { datasetId: 'ds-1', sourceType: 'apiFile', sourceRef: 'x', options: { timeoutMs: 1000 } },
        embeddingContext,
      ),
    ).rejects.toMatchObject({ error: { code: 501017 } });
    await expect(
      runtime.ports.datasetSourceProvider.read(
        {
          datasetId: 'ds-1',
          sourceType: 'unknownType',
          sourceRef: 'x',
          options: { timeoutMs: 1000 },
        },
        embeddingContext,
      ),
    ).rejects.toMatchObject({ error: { code: 501035 } });
  });

  it('uses an explicitly injected dataset source provider', async () => {
    const clients = fakeClients();
    const injected = {
      read: async () => ({ contentHash: 'sha256:injected' }),
      preview: async () => ({ contentHash: 'sha256:injected' }),
    };
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
      datasetSourceProvider: injected,
    });
    expect(runtime.datasetSourceProvider).toBe(injected);
    expect(runtime.ports.datasetSourceProvider).toBe(injected);
  });

  it('keeps the default registry even when explicit ports are supplied', async () => {
    const clients = fakeClients();
    const runtime = await bootstrapRuntime({
      getBaseRuntime: async () => fakeBaseRuntime(clients),
      drain: async () => undefined,
      closeClients: async () => undefined,
      ports: createDefaultPorts(),
    });
    // createDefaultPorts() 的 datasetSourceProvider 是未实现 Port；不得覆盖默认真实 Registry。
    expect(runtime.datasetSourceProvider).toBeInstanceOf(SourceProviderRegistry);
    expect(runtime.ports.datasetSourceProvider).toBe(runtime.datasetSourceProvider);
    await expect(
      runtime.ports.datasetSourceProvider.read(
        {
          datasetId: 'ds-1',
          sourceType: 'unknownType',
          sourceRef: 'x',
          options: { timeoutMs: 1000 },
        },
        embeddingContext,
      ),
    ).rejects.toMatchObject({ error: { code: 501035 } });
  });
});
