import { QUEUE_NAMES } from '@kb/dal';
import type {
  AdminDatasetPort,
  MigrationRegistryPort,
  TaskResult,
} from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';
import {
  DEFAULT_JOB_PORT_TIMEOUT_MS,
  createJobHandlerRegistry,
} from '../../../shared/runtime/job-registry';
import { ConfigValidationException } from '../../../shared/config/config-error';

const RECONCILE_RUN_DEFINITION: JobDefinition = {
  name: 'reconcile-run',
  queue: QUEUE_NAMES.reconcile,
  modes: ['reconcile'],
  stableIdTemplate: 'reconcile:windowStart:windowEnd:scope',
};

const MIGRATION_RUN_DEFINITION: JobDefinition = {
  name: 'migration-run',
  queue: QUEUE_NAMES.migration,
  modes: ['migration'],
  stableIdTemplate: 'teamId:migrationId:batchId',
};

/** P3-04：原骨架把 reconcile/migration 挂在同一队列；按设计 12.10 拆分到两个契约队列。 */
export const MIGRATION_RUN_JOB_DEFINITIONS: readonly JobDefinition[] = [
  RECONCILE_RUN_DEFINITION,
  MIGRATION_RUN_DEFINITION,
];

export interface MigrationRunJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface MigrationRunJobHandlerDeps {
  migrationRegistry: MigrationRegistryPort;
  adminDataset?: AdminDatasetPort;
}

/** payload 白名单（P3-04）：未识别字段一律丢弃。 */
const MIGRATION_PAYLOAD_FIELDS = [
  'runId',
  'cursor',
  'resumeToken',
  'version',
  'scope',
  'window',
  'idempotencyKey',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whitelistPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const mapped: Record<string, unknown> = {};
  for (const field of MIGRATION_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) mapped[field] = payload[field];
  }
  return mapped;
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 真实薄 handler（P3-04）：reconcile 走 AdminDatasetPort，migration 走 MigrationRegistryPort。 */
export function createMigrationRunJobHandler(
  deps: MigrationRunJobHandlerDeps,
): MigrationRunJobHandler {
  const registry = createJobHandlerRegistry();
  registry.register(RECONCILE_RUN_DEFINITION, {
    handle: async (envelope, context) => {
      if (!deps.adminDataset) {
        throw new ConfigValidationException(['reconcile 模式需要注入 AdminDatasetPort']);
      }
      const payload = whitelistPayload(envelope.payload);
      await deps.adminDataset.reconcile(
        {
          window: stringField(payload, 'window') ?? envelope.jobId,
          scope: payload['scope'] ?? null,
          idempotencyKey: stringField(payload, 'idempotencyKey') ?? envelope.jobId,
          options: { timeoutMs: context.timeoutMs ?? DEFAULT_JOB_PORT_TIMEOUT_MS },
        },
        context,
      );
      return { state: 'success', producedItems: 0 };
    },
  });
  registry.register(MIGRATION_RUN_DEFINITION, {
    handle: async (envelope, context) => {
      const payload = whitelistPayload(envelope.payload);
      const options = { timeoutMs: context.timeoutMs ?? DEFAULT_JOB_PORT_TIMEOUT_MS };
      const idempotencyKey = stringField(payload, 'idempotencyKey') ?? envelope.jobId;
      if (stringField(payload, 'resumeToken') !== undefined) {
        await deps.migrationRegistry.resume(
          {
            runId: stringField(payload, 'runId') ?? envelope.jobId,
            cursor: stringField(payload, 'cursor') ?? stringField(payload, 'resumeToken') ?? '',
            idempotencyKey,
            options,
          },
          context,
        );
      } else {
        await deps.migrationRegistry.apply(
          {
            version: stringField(payload, 'version') ?? '',
            scope: payload['scope'] ?? null,
            idempotencyKey,
            options,
          },
          context,
        );
      }
      return { state: 'success', producedItems: 0 };
    },
  });
  return {
    handle: async (envelope, context) =>
      registry
        .resolve(envelope.queue, envelope.mode, {
          requestId: context.requestId,
          taskId: envelope.jobId,
        })
        .handle(envelope, context),
  };
}
