import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueuePort } from '../../packages/dal/src/index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  KnowledgeOutboxDispatcher,
  createKnowledgeOutboxEvent,
} from '../../packages/service/src/shared/persistence/knowledge/outbox';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import {
  classifyExternalFailure,
  redactExternalValue,
} from '../../packages/service/src/modules/knowledge/adapter/external-providers';
import { createTelemetryRuntime } from '../../sdk/otel/src';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_fault_${suffix}`;
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const context: TenantContext = {
  workspaceId,
  memberId: `member_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
  await connection.close();
});

describe('knowledge fault contracts', () => {
  it('degrades telemetry exporter failures without affecting business work', async () => {
    const telemetry = createTelemetryRuntime(
      {
        serviceName: 'knowledge-fault-test',
        endpoint: 'http://127.0.0.1:4318',
        exportIntervalMillis: 60_000,
      },
      {
        traceExporterFactory: () => {
          throw new Error('trace down');
        },
        metricExporterFactory: () => {
          throw new Error('metrics down');
        },
        logExporterFactory: () => {
          throw new Error('logs down');
        },
      },
    );
    expect(telemetry.state().mode).toBe('degraded');
    await expect(
      telemetry.withSpan('knowledge.fault.test', { operation: 'test' }, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(() =>
      telemetry.log('knowledge.fault.test', {
        requestId: 'request-safe',
        route: 'postgres://user:password@db/knowledge',
      }),
    ).not.toThrow();
    await expect(telemetry.dispose()).resolves.toBeUndefined();
  });

  it('classifies provider timeout/auth/rate failures and redacts secrets', () => {
    expect(classifyExternalFailure({ timeout: true })).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(classifyExternalFailure({ status: 401 })).toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    expect(classifyExternalFailure({ status: 429 })).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
    expect(redactExternalValue({ authorization: 'Bearer secret' })).toEqual({
      authorization: '[REDACTED]',
    });
  });

  it('keeps Outbox failed instead of claiming successful dispatch when Redis fails', async () => {
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await createKnowledgeOutboxEvent(
          connection,
          {
            workspaceId,
            knowledgeSpaceId: String(spaceId),
            eventType: 'delete',
            aggregateType: 'source',
            aggregateId: `source_${suffix}`,
            queue: 'knowledge-delete',
            payload: { sourceId: `source_${suffix}` },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    const failedQueue: QueuePort = {
      async enqueue() {
        throw new Error('redis unavailable');
      },
      async remove() {},
      async close() {},
    };
    const result = await new KnowledgeOutboxDispatcher(connection, failedQueue).dispatchOnce(
      context,
    );
    expect(result.dispatched).toBe(false);
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeOutboxEvent.findOne({ workspaceId });
    expect(event?.status).toBe('failed');
    expect(event?.publishedAt).toBeNull();
  });
});
