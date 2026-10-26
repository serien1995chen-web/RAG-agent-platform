import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueuePort } from '../../packages/dal/src/index';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
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
import { FileTicketService } from '../../sdk/storage/src';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
} from '../../packages/service/src/modules/knowledge';
import { createTelemetryRuntime } from '../../sdk/otel/src';
import { safeErrorAttributes } from '../../sdk/otel/src/redaction';

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
  isWorkspaceOwner: true,
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let application: KnowledgeApplication;
let catalog: KnowledgeCatalogRepository;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  application = new KnowledgeApplication(
    catalog,
    {} as never,
    new KnowledgeAccessRepository(connection),
    {} as never,
    undefined,
    undefined,
    undefined,
    new KnowledgeAuditRepository(connection),
  );
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
  await connection.close();
});

describe('knowledge fault contracts', () => {
  it('degrades telemetry exporter failures without affecting business work', async () => {
    const failedSpanExporter = {
      export(_spans: unknown, callback: (result: { code: number }) => void) {
        callback({ code: 1 });
      },
      forceFlush: async () => {
        throw new Error('trace flush failed');
      },
      shutdown: async () => {
        throw new Error('trace shutdown failed');
      },
    } as unknown as SpanExporter;
    const failedMetricExporter = {
      export(_metrics: unknown, callback: (result: { code: number }) => void) {
        callback({ code: 1 });
      },
      forceFlush: async () => {
        throw new Error('metric flush failed');
      },
      shutdown: async () => {
        throw new Error('metric shutdown failed');
      },
    } as unknown as PushMetricExporter;
    const failedLogExporter = {
      export(_records: unknown, callback: (result: { code: number }) => void) {
        callback({ code: 1 });
      },
      shutdown: async () => {
        throw new Error('log shutdown failed');
      },
    } as unknown as LogRecordExporter;
    const telemetry = createTelemetryRuntime(
      {
        serviceName: 'knowledge-fault-test',
        endpoint: 'http://127.0.0.1:4318',
        exportIntervalMillis: 60_000,
      },
      {
        traceExporterFactory: () => failedSpanExporter,
        metricExporterFactory: () => failedMetricExporter,
        logExporterFactory: () => failedLogExporter,
      },
    );
    await expect(
      telemetry.withSpan('knowledge.fault.test', { operation: 'test' }, async () => 'ok'),
    ).resolves.toBe('ok');
    const exception = Object.assign(new Error('Authorization: Bearer stack-secret'), {
      code: 'KNOWLEDGE_INTERNAL_ERROR',
    });
    await expect(
      telemetry.withSpan('knowledge.fault.exception', { operation: 'test' }, async () => {
        throw exception;
      }),
    ).rejects.toThrow('Authorization');
    telemetry.recordUsage({
      name: 'knowledge.fault.metric',
      attributes: { operation: 'test', requestId: 'metric-identifier' },
    });
    expect(() =>
      telemetry.log('knowledge.fault.test', {
        requestId: 'request-safe',
        route: 'postgres://user:password@db/knowledge',
      }),
    ).not.toThrow();
    await expect(telemetry.dispose()).resolves.toBeUndefined();
    const safeException = JSON.stringify(safeErrorAttributes(exception));
    const exceptionHasSecret =
      safeException.includes('stack-secret') || safeException.includes('Authorization');
    console.log(`EXCEPTION_HAS_SECRET=${exceptionHasSecret}`);
    console.log(`mode=${telemetry.state().mode} DROPPED=${telemetry.droppedRecords()}`);
    expect(telemetry.state().mode).toBe('degraded');
    expect(telemetry.droppedRecords()).toBeGreaterThan(0);
    expect(exceptionHasSecret).toBe(false);
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

  it('keeps successful batch items after an independent item failure', async () => {
    const target = await catalog.createSpace(
      {
        kind: 'folder',
        name: `Batch fault target ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const good = await catalog.createSpace(
      {
        kind: 'space',
        name: `Batch fault good ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const failed = await catalog.createSpace(
      {
        kind: 'space',
        name: `Batch fault failed ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const result = await application.dispatch({
      operationId: 'API-SPACE-BATCH',
      params: {},
      query: {},
      headers: {},
      body: {
        action: 'move',
        ids: [good.id, failed.id],
        targetParentId: target.id,
        versions: {
          [good.id]: good.version,
          [failed.id]: failed.version + 1,
        },
      },
      context,
    });
    expect(result.status).toBe(207);
    expect(result.data).toMatchObject({ succeeded: 1, failed: 1 });
    expect(await catalog.getSpace(good.id, context)).toMatchObject({
      parentSpaceId: target.id,
      version: good.version + 1,
    });
    expect(await catalog.getSpace(failed.id, context)).toMatchObject({
      parentSpaceId: null,
      version: failed.version,
    });
  });

  it('expires export download tickets deterministically', () => {
    let now = Date.now();
    const tickets = new FileTicketService(
      'fault-ticket-secret-at-least-32-characters',
      'http://127.0.0.1:3010',
      () => now,
    );
    const blobId = '65f1e5b2a1c9d4b7e8f01234';
    const issued = tickets.issue(
      {
        workspaceId,
        blobId,
        sourceId: null,
        knowledgeSpaceId: spaceId,
        disposition: 'attachment',
        ttlSeconds: 1,
      },
      context.requestId,
      context.traceId,
    );
    expect(tickets.verify(issued.ticket, context.requestId, context.traceId)).toMatchObject({
      workspaceId,
      blobId,
      knowledgeSpaceId: spaceId,
      disposition: 'attachment',
    });
    now += 2_000;
    expect(() => tickets.verify(issued.ticket, context.requestId, context.traceId)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({
            code: 'KNOWLEDGE_FORBIDDEN',
            details: expect.objectContaining({ reason: 'ticket_expired' }),
          }),
        }),
      }),
    );
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
