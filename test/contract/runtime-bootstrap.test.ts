import type mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
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

    await runtime.shutdown();
    await runtime.shutdown();
    expect(events).toEqual(['drain', 'close']);
  });
});
