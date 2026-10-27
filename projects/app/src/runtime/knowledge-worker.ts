import { BullMqQueueAdapter, KNOWLEDGE_QUEUE_NAMES } from '@kb/dal';
import { configureTelemetry } from '@kb/otel';
import { unlinkSync, writeFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  KnowledgeOutboxDispatcher,
  loadKnowledgeRuntimeConfig,
  registerKnowledgeModels,
  type TenantContext,
} from '@kb/service';
import { createFileCleanupCycle } from './file-worker';
import { KnowledgeArchiveWorker } from './archive-worker';
import { getKnowledgeWorkerServices } from './knowledge-runtime';
import { S06JobHandlers, type S06QueuePayload } from './s06-job-handlers';
import { createWorkerRegistry, startWorkerRegistry } from './worker-registry';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 20;

const QUEUE_SETTINGS = {
  'knowledge-import': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-parse': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-segment': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-qa': { concurrency: 10, timeoutMs: 900_000, maxAttempts: 3 },
  'knowledge-ocr': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-caption': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-embed': { concurrency: 10, timeoutMs: 600_000, maxAttempts: 3 },
  'knowledge-index': { concurrency: 10, timeoutMs: 300_000, maxAttempts: 3 },
  'knowledge-rebuild': { concurrency: 10, timeoutMs: 1_800_000, maxAttempts: 3 },
  'knowledge-sync': { concurrency: 4, timeoutMs: 1_800_000, maxAttempts: 4 },
  'knowledge-delete': { concurrency: 4, timeoutMs: 900_000, maxAttempts: 5 },
  'knowledge-outbox': { concurrency: 20, timeoutMs: 30_000, maxAttempts: 10 },
  'knowledge-cleanup': { concurrency: 4, timeoutMs: 1_800_000, maxAttempts: 5 },
} as const;

async function start(): Promise<void> {
  const config = loadKnowledgeRuntimeConfig();
  const telemetry = configureTelemetry({
    serviceName: 'knowledge-worker',
    ...(config.otelEndpoint ? { endpoint: config.otelEndpoint } : {}),
    logLevel: config.logLevel,
  });
  if (config.workerMode === 'http') {
    telemetry.log('knowledge.worker.disabled', { operation: 'bootstrap' });
    return;
  }
  const { mongo, redis, processing, close: closeServices } = await getKnowledgeWorkerServices();
  const models = registerKnowledgeModels(mongo);
  const queue = new BullMqQueueAdapter({ connection: redis });
  const dispatcher = new KnowledgeOutboxDispatcher(mongo, queue);
  const handlers = new S06JobHandlers(processing);
  const definitions = KNOWLEDGE_QUEUE_NAMES.map((queueName) => ({
    queue: queueName,
    ...QUEUE_SETTINGS[queueName],
    backoffMs: [1_000, 5_000, 30_000],
    handler: (payload: S06QueuePayload, workerId: string) =>
      queueName === 'knowledge-import'
        ? handlers.import(payload, workerId)
        : handlers.queue(queueName, payload, workerId),
  }));
  const registry = createWorkerRegistry(definitions);
  const workers = startWorkerRegistry({
    registry,
    connection: redis,
    workerId: `${config.instanceId}:${process.pid}:${nanoid(10)}`,
    logger: telemetry,
  });
  await workers.ready;
  const fileCleanup = createFileCleanupCycle({
    connection: mongo,
    config,
    instanceId: config.instanceId,
  });
  const archiveWorker = new KnowledgeArchiveWorker(mongo, config, config.instanceId);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      await telemetry.withSpan(
        'knowledge.worker.tick',
        { operation: 'outbox.dispatch' },
        async () => {
          const workspaces = await models.KnowledgeOutboxEvent.distinct('workspaceId', {
            status: { $in: ['pending', 'failed'] },
          });
          for (const workspaceId of workspaces) {
            if (typeof workspaceId !== 'string') continue;
            const context: TenantContext = {
              workspaceId,
              memberId: 'system:knowledge-worker',
              requestId: `worker:${Date.now()}`,
              traceId: `worker:${config.instanceId}`,
              scopes: ['knowledge:admin'],
              isWorkspaceOwner: false,
            };
            await processing.recoverExpiredLeases(context);
            await processing.requeueDueRetries(context);
            for (let index = 0; index < BATCH_SIZE; index += 1) {
              const result = await dispatcher.dispatchOnce(context);
              if (!result.dispatched) break;
            }
          }
        },
      );
      await fileCleanup.runOnce();
      await archiveWorker.runOnce();
      telemetry.log('knowledge.worker.object_cleanup', {
        operation: 'object.cleanup',
      });
    } catch (error) {
      telemetry.log('knowledge.worker.cycle.failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      if (!stopping) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    try {
      unlinkSync('/tmp/knowledge-worker-ready');
    } catch {
      // The readiness marker may already be absent after an abnormal start.
    }
    await workers.close();
    await queue.close();
    await closeServices();
    telemetry.log('knowledge.worker.stopped', { operation: 'shutdown' });
    await telemetry.dispose();
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  telemetry.log('knowledge.worker.started', {
    operation: `bootstrap:${KNOWLEDGE_QUEUE_NAMES.length}`,
  });
  writeFileSync('/tmp/knowledge-worker-ready', 'ready\n');
  await tick();
}

start().catch((error) => {
  process.stderr.write(
    `knowledge.worker.bootstrap.failed ${error instanceof Error ? error.name : typeof error}\n`,
  );
  process.exit(1);
});
