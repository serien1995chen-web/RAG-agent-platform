import { BullMqQueueAdapter } from '@kb/dal';
import { writeFileSync } from 'node:fs';
import {
  KnowledgeOutboxDispatcher,
  createKnowledgeConnections,
  ensureKnowledgeCollections,
  ensurePgvectorDdl,
  loadKnowledgeRuntimeConfig,
  registerKnowledgeModels,
  type TenantContext,
} from '@kb/service';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 20;

async function start(): Promise<void> {
  const config = loadKnowledgeRuntimeConfig();
  if (config.workerMode === 'http') {
    process.stdout.write('knowledge worker disabled by KB_APP_WORKER_MODE=http\n');
    return;
  }
  const connections = await createKnowledgeConnections(config);
  await ensureKnowledgeCollections(connections.mongo);
  const models = registerKnowledgeModels(connections.mongo);
  await ensurePgvectorDdl(connections.pg);
  const queue = new BullMqQueueAdapter({ connection: connections.redis });
  const dispatcher = new KnowledgeOutboxDispatcher(connections.mongo, queue);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
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
        for (let index = 0; index < BATCH_SIZE; index += 1) {
          const result = await dispatcher.dispatchOnce(context);
          if (!result.dispatched) break;
        }
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'knowledge.worker.cycle_failed',
          errorName: error instanceof Error ? error.name : typeof error,
        })}\n`,
      );
    } finally {
      if (!stopping) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    await queue.close();
    await connections.close();
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.stdout.write(
    `${JSON.stringify({ event: 'knowledge.worker.started', instanceId: config.instanceId })}\n`,
  );
  writeFileSync('/tmp/knowledge-worker-ready', 'ready\n');
  await tick();
}

start().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'knowledge.worker.bootstrap_failed',
      errorName: error instanceof Error ? error.name : typeof error,
    })}\n`,
  );
  process.exitCode = 1;
});
