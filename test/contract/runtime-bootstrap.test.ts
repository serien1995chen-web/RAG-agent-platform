import type mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT_IDS } from '../../packages/service/src/index';
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
});
