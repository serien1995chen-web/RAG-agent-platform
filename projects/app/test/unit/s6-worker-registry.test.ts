import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_QUEUE_NAMES } from '@kb/dal';
import {
  createWorkerRegistry,
  type QueueConsumerDefinition,
} from '../../src/runtime/worker-registry';
import type { S06QueuePayload } from '../../src/runtime/s06-job-handlers';

function definition(queue: (typeof KNOWLEDGE_QUEUE_NAMES)[number]): QueueConsumerDefinition {
  return {
    queue,
    concurrency: 1,
    timeoutMs: 10_000,
    maxAttempts: 3,
    backoffMs: [1_000],
    handler: async (_payload: S06QueuePayload) => 'succeeded',
  };
}

describe('S6 worker registry', () => {
  it('requires all 13 canonical queues', () => {
    expect(() => createWorkerRegistry([])).toThrow();
    const registry = createWorkerRegistry(KNOWLEDGE_QUEUE_NAMES.map(definition));
    expect(registry.size).toBe(13);
    expect([...registry.keys()]).toEqual([...KNOWLEDGE_QUEUE_NAMES]);
  });

  it('rejects duplicate and unknown registrations', () => {
    const duplicate = [definition('knowledge-import'), definition('knowledge-import')];
    expect(() => createWorkerRegistry(duplicate)).toThrow();
    const unknown = definition('knowledge-import');
    expect(() =>
      createWorkerRegistry([
        ...KNOWLEDGE_QUEUE_NAMES.slice(1).map(definition),
        { ...unknown, queue: 'dataset-legacy' as never },
      ]),
    ).toThrow();
  });
});
