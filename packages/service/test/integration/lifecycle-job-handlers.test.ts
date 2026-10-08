import { ApiErrorException, classifyRetryableError, createApiError } from '@kb/contracts';
import {
  JOB_MODE_TO_QUEUE,
  QUEUE_NAMES,
  buildDeleteJobId,
  buildMigrationJobId,
  buildReconcileJobId,
  buildSyncJobId,
} from '@kb/dal';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationException,
  DELETE_JOB_JOB_DEFINITIONS,
  KNOWLEDGE_BASE_JOB_DEFINITIONS,
  MIGRATION_RUN_JOB_DEFINITIONS,
  createDeleteJobJobHandler,
  createKnowledgeBaseJobHandler,
  createMigrationRunJobHandler,
} from '../../src/index';
import type {
  AdminDatasetPort,
  DatasetSyncPort,
  MigrationRegistryPort,
} from '../../src/ports/capabilities';
import type { DeleteJobRepository } from '../../src/ports/repositories';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../src/ports/types';
import { createJobHandlerRegistry } from '../../src/shared/runtime/job-registry';

const context: RequestContext = {
  requestId: 'req-1',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function envelopeOf(overrides: Partial<JobEnvelope>): JobEnvelope {
  return {
    jobId: 'job-1',
    queue: QUEUE_NAMES.delete,
    mode: 'delete',
    teamId: 'team-1',
    retryCount: 0,
    lockTime: null,
    payload: {},
    ...overrides,
  };
}

function definitionOf(definitions: readonly JobDefinition[]): JobDefinition {
  const [definition] = definitions;
  if (!definition) throw new Error('missing job definition');
  return definition;
}

function fakeDeleteRepository(seen: string[]): DeleteJobRepository {
  return {
    create: async () => ({ jobId: 'delete-created' }),
    get: async (input: { jobId: string }) => {
      seen.push(input.jobId);
      return {
        jobId: input.jobId,
        teamId: 'team-1',
        datasetId: 'ds-1',
        state: 'queued',
        stage: 'delete',
        progress: 0,
        failureCount: 0,
        createTime: '2026-01-01T00:00:00.000Z',
        updateTime: '2026-01-01T00:00:00.000Z',
      };
    },
    listFailures: async () => ({ total: 0, list: [], cursor: null }),
    retry: async () => ({ accepted: true }),
  } as unknown as DeleteJobRepository;
}

describe('生命周期 Job Handler 注册 (P3-04 / 设计 12.10 / 9.13 / 17.2)', () => {
  it('定义落在契约内，migration 拆分到 reconcile/migration 两个队列', () => {
    const all = [
      ...DELETE_JOB_JOB_DEFINITIONS,
      ...KNOWLEDGE_BASE_JOB_DEFINITIONS,
      ...MIGRATION_RUN_JOB_DEFINITIONS,
    ];
    const queueNames = new Set<string>(Object.values(QUEUE_NAMES));
    for (const definition of all) {
      expect(queueNames.has(definition.queue), `${definition.name} 使用契约外队列`).toBe(true);
      for (const mode of definition.modes) {
        expect(JOB_MODE_TO_QUEUE[mode]).toBe(definition.queue);
      }
    }
    expect(MIGRATION_RUN_JOB_DEFINITIONS.map((definition) => definition.queue).sort()).toEqual(
      [QUEUE_NAMES.migration, QUEUE_NAMES.reconcile].sort(),
    );
    expect(MIGRATION_RUN_JOB_DEFINITIONS.flatMap((definition) => definition.modes).sort()).toEqual([
      'migration',
      'reconcile',
    ]);
  });

  it('四类处理器可被 Worker 发现：delete/sync/reconcile/migration', async () => {
    const seen: string[] = [];
    const calls: string[] = [];
    const deleteHandler = createDeleteJobJobHandler({
      deleteRepository: fakeDeleteRepository(seen),
    });
    const datasetSync: DatasetSyncPort = {
      sync: async (input) => {
        calls.push(`sync:${input.datasetId}:${input.idempotencyKey}`);
        return { state: 'active', changed: 2, removed: 1 };
      },
    };
    const syncHandler = createKnowledgeBaseJobHandler({ datasetSync });
    const migrationRegistry: MigrationRegistryPort = {
      dryRun: async () => ({ diff: {}, state: 'dry' }),
      apply: async (input) => {
        calls.push(`apply:${input.version}`);
        return { runId: 'run-1', cursor: null, state: 'done' };
      },
      resume: async (input) => {
        calls.push(`resume:${input.runId}:${input.cursor}`);
        return { runId: input.runId, cursor: null, state: 'done' };
      },
      rollback: async () => ({ state: 'rolled' }),
    };
    const adminDataset: AdminDatasetPort = {
      migrate: async () => ({ runId: 'run-1', state: 'done' }),
      reconcile: async (input) => {
        calls.push(`reconcile:${input.window}`);
        return { reportId: 'report-1' };
      },
      report: async () => ({}),
    };
    const migrationHandler = createMigrationRunJobHandler({ migrationRegistry, adminDataset });

    await expect(
      deleteHandler.handle(
        envelopeOf({ payload: { jobId: 'delete-1', stage: 'delete' } }),
        context,
      ),
    ).resolves.toEqual({ state: 'success', producedItems: 0 });
    expect(seen).toEqual(['delete-1']);

    await expect(
      syncHandler.handle(
        envelopeOf({
          queue: QUEUE_NAMES.sync,
          mode: 'sync',
          datasetId: 'ds-1',
          payload: { datasetId: 'ds-1', idempotencyKey: 'k-1' },
        }),
        context,
      ),
    ).resolves.toEqual({ state: 'success', producedItems: 3 });

    await expect(
      migrationHandler.handle(
        envelopeOf({
          queue: QUEUE_NAMES.reconcile,
          mode: 'reconcile',
          payload: { window: 'w-1' },
        }),
        context,
      ),
    ).resolves.toEqual({ state: 'success', producedItems: 0 });

    await expect(
      migrationHandler.handle(
        envelopeOf({
          queue: QUEUE_NAMES.migration,
          mode: 'migration',
          payload: { runId: 'run-9', resumeToken: 'token-9' },
        }),
        context,
      ),
    ).resolves.toEqual({ state: 'success', producedItems: 0 });

    await expect(
      migrationHandler.handle(
        envelopeOf({
          queue: QUEUE_NAMES.migration,
          mode: 'migration',
          payload: { version: 'v1', scope: { datasetIds: ['ds-1'] } },
        }),
        context,
      ),
    ).resolves.toEqual({ state: 'success', producedItems: 0 });

    expect(calls).toEqual(['sync:ds-1:k-1', 'reconcile:w-1', 'resume:run-9:token-9', 'apply:v1']);
  });

  it('重复注册 (queue, mode) 启动失败', () => {
    const registry = createJobHandlerRegistry();
    const definition = definitionOf(DELETE_JOB_JOB_DEFINITIONS);
    const handler = { handle: async () => ({ state: 'success' as const }) };
    registry.register(definition, handler);
    expect(() => registry.register(definition, handler)).toThrow(ConfigValidationException);
    expect(registry.definitions()).toEqual([definition]);
  });

  it('稳定 jobId 重复投递保持相同（去重语义）', () => {
    expect(buildDeleteJobId('team-1', 'ds-1')).toBe(buildDeleteJobId('team-1', 'ds-1'));
    expect(buildSyncJobId('team-1', 'ds-1')).toBe(buildSyncJobId('team-1', 'ds-1'));
    expect(buildReconcileJobId('w-1', 'w-2', 'all')).toBe(buildReconcileJobId('w-1', 'w-2', 'all'));
    expect(buildMigrationJobId('team-1', 'm-1', 'b-1')).toBe(
      buildMigrationJobId('team-1', 'm-1', 'b-1'),
    );
    expect(buildDeleteJobId('team-1', 'ds-1')).not.toBe(buildDeleteJobId('team-1', 'ds-2'));
  });

  it('501020 原样上抛并按 no-retry 分类，不被重包装', async () => {
    const error = new ApiErrorException(
      createApiError({ code: 501020, requestId: 'req-1', params: { extension: 'pro' } }),
    );
    const datasetSync: DatasetSyncPort = {
      sync: async () => {
        throw error;
      },
    };
    const handler = createKnowledgeBaseJobHandler({ datasetSync });
    let caught: unknown;
    try {
      await handler.handle(
        envelopeOf({
          queue: QUEUE_NAMES.sync,
          mode: 'sync',
          datasetId: 'ds-1',
          payload: { datasetId: 'ds-1', idempotencyKey: 'k-1' },
        }),
        context,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(error);
    expect(classifyRetryableError(caught)).toBe('no-retry');
  });
});
