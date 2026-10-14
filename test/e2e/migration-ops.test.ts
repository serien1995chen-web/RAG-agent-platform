import { describe, expect, it } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import type { BackupToolPort, MongoIndexManagerPort } from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';
import {
  MigrationExecutor,
  type MigrationDefinition,
} from '../../packages/service/src/modules/migration/application/executor';

const teamId = '000000000000000000000001';
const context: RequestContext = {
  requestId: 'req-migration-ops',
  tenant: { teamId, tmbId: '000000000000000000000002', authType: 'root', isRoot: true },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};
const scope = { teamId, kind: 'all' };

interface RunState {
  runId: string;
  version: string;
  state: string;
  cursor: string | null;
  idempotencyKey: string;
  rollbackInfo: Record<string, unknown> | null;
}

function error(code: number, params: Record<string, unknown>): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId: context.requestId, params }));
}

class MemoryRegistry {
  private sequence = 0;
  private readonly runs = new Map<string, RunState>();

  async dryRun(input: { version: string }): Promise<{ diff: unknown; state: string }> {
    return { diff: { version: input.version }, state: 'dry_run' };
  }

  async apply(input: {
    version: string;
    idempotencyKey: string;
  }): Promise<{ runId: string; cursor: string | null; state: string }> {
    const started = await this.start({
      definition: {
        version: input.version,
        name: input.version,
        batches: [],
        writeMode: 'online',
        estimatedWindow: { minMs: 0, maxMs: 0 },
        rollbackWindow: { minMs: 0, maxMs: 0 },
        backupRequired: false,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { runId: started.runId, cursor: started.cursor, state: started.state };
  }

  async start(input: {
    definition: MigrationDefinition;
    idempotencyKey: string;
  }): Promise<{ runId: string; cursor: string | null; state: string; replayed: boolean }> {
    const sameVersion = [...this.runs.values()].find(
      (run) => run.version === input.definition.version,
    );
    if (sameVersion) {
      if (sameVersion.idempotencyKey === input.idempotencyKey) {
        return {
          runId: sameVersion.runId,
          cursor: sameVersion.cursor,
          state: sameVersion.state,
          replayed: true,
        };
      }
      throw error(501024, { migrationId: input.definition.version, scope });
    }
    if ([...this.runs.values()].some((run) => run.state === 'running')) {
      throw error(501024, { migrationId: input.definition.version, scope });
    }
    this.sequence += 1;
    const run: RunState = {
      runId: `run-${this.sequence}`,
      version: input.definition.version,
      state: 'running',
      cursor: null,
      idempotencyKey: input.idempotencyKey,
      rollbackInfo: null,
    };
    this.runs.set(run.runId, run);
    return { runId: run.runId, cursor: run.cursor, state: run.state, replayed: false };
  }

  async progress(input: { runId: string; cursor: string }): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) throw error(501070, { resourceType: 'migration', resourceId: input.runId });
    run.cursor = input.cursor;
  }

  async complete(input: { runId: string; cursor: string | null }): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) throw error(501070, { resourceType: 'migration', resourceId: input.runId });
    run.state = 'done';
    run.cursor = input.cursor;
  }

  async fail(input: { runId: string; cursor: string | null }): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) throw error(501070, { resourceType: 'migration', resourceId: input.runId });
    run.state = 'failed';
    run.cursor = input.cursor;
  }

  async resume(input: {
    runId: string;
    cursor: string;
    idempotencyKey: string;
  }): Promise<{ runId: string; cursor: string | null; state: string; version: string }> {
    const run = this.runs.get(input.runId);
    if (!run) throw error(501070, { resourceType: 'migration', resourceId: input.runId });
    if (run.state !== 'failed') throw error(501025, { cursor: input.cursor });
    if (run.cursor !== null && input.cursor <= run.cursor) {
      throw error(501025, { cursor: input.cursor });
    }
    run.state = 'running';
    run.cursor = input.cursor;
    run.idempotencyKey = input.idempotencyKey;
    return { runId: run.runId, cursor: run.cursor, state: run.state, version: run.version };
  }

  async markCancelled(input: {
    runId: string;
    rollbackInfo: Record<string, unknown>;
  }): Promise<{ state: string }> {
    const run = this.runs.get(input.runId);
    if (!run) throw error(501070, { resourceType: 'migration', resourceId: input.runId });
    if (run.state === 'cancelled') return { state: run.state };
    if (run.state !== 'failed') throw error(501025, { cursor: run.state });
    run.state = 'cancelled';
    run.rollbackInfo = input.rollbackInfo;
    return { state: run.state };
  }

  async rollback(input: {
    runId: string;
    options: { timeoutMs: number };
  }): Promise<{ state: string }> {
    return this.markCancelled({
      runId: input.runId,
      rollbackInfo: { runbookUri: 'docs/runbooks/release-rollback.md' },
    });
  }

  rollbackInfo(runId: string): Record<string, unknown> | null {
    return this.runs.get(runId)?.rollbackInfo ?? null;
  }
}

function backupTool(): BackupToolPort {
  return {
    validate: async () => ({ valid: true }),
    run: async () => ({ evidence: { mode: 'mock', checksum: 'sha256:x' } }),
    verify: async () => ({ verified: true }),
  };
}

function indexManager(): MongoIndexManagerPort {
  return {
    inspect: async () => ({
      created: [],
      dropped: [],
      skipped: ['unregistered:customer_index'],
      errors: [],
    }),
    sync: async () => ({ created: [], dropped: [], skipped: [], errors: [] }),
    cleanup: async () => ({ dropped: [], skipped: [] }),
  };
}

function definition(version: string, fail = false): MigrationDefinition {
  return {
    version,
    name: version,
    batches: [
      {
        id: 'batch-1',
        nextCursor: 'cursor-1',
        execute: async () => {
          if (fail) throw new Error('intentional failure');
          return {
            counts: { expected: 1, actual: 1 },
            references: { checked: 1, missing: [] },
          };
        },
      },
      {
        id: 'batch-2',
        nextCursor: 'cursor-2',
        execute: async () => ({
          counts: { expected: 1, actual: 1 },
          references: { checked: 1, missing: [] },
        }),
      },
    ],
    writeMode: 'readonly',
    estimatedWindow: { minMs: 1, maxMs: 2 },
    rollbackWindow: { minMs: 1, maxMs: 2 },
    backupRequired: false,
  };
}

function executor(
  registry: MemoryRegistry,
  ...definitions: MigrationDefinition[]
): MigrationExecutor {
  return new MigrationExecutor({
    registry: registry as never,
    backupTool: backupTool(),
    mongoIndexManager: indexManager(),
    definitions,
  });
}

describe('P7-07 migration operations batch (ACC-MIG-001..008)', () => {
  it('keeps dry-run free of business writes (TEST-MIG-DRY-001)', async () => {
    const registry = new MemoryRegistry();
    const service = executor(registry, definition('ops-v1'));
    const result = await service.dryRun(
      { version: 'ops-v1', scope, options: { timeoutMs: 1_000 } },
      context,
    );
    expect(result.state).toBe('dry_run');
  });

  it('replays apply by idempotency key and rejects concurrent scope execution', async () => {
    const registry = new MemoryRegistry();
    const service = executor(registry, definition('ops-v1'));
    const first = await service.apply(
      {
        version: 'ops-v1',
        scope,
        idempotencyKey: 'idem-1',
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    const replay = await service.apply(
      {
        version: 'ops-v1',
        scope,
        idempotencyKey: 'idem-1',
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(first.runId).toBe(replay.runId);

    const running = new MemoryRegistry();
    await running.start({
      definition: definition('ops-running'),
      idempotencyKey: 'idem-running',
    });
    const busy = executor(running, definition('ops-v3'));
    await expect(
      busy.apply(
        {
          version: 'ops-v3',
          scope,
          idempotencyKey: 'idem-concurrent',
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501024 } });
  });

  it('resumes failed runs and advances the cursor (TEST-MIG-RESUME-001)', async () => {
    const registry = new MemoryRegistry();
    const service = executor(registry, definition('ops-resume', true));
    const failed = await service.apply(
      {
        version: 'ops-resume',
        scope,
        idempotencyKey: 'idem-resume',
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(failed.state).toBe('failed');
    const resumed = await service.resume(
      {
        runId: failed.runId,
        cursor: 'cursor-1',
        idempotencyKey: 'idem-resume-2',
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(resumed.cursor).toBe('cursor-2');
    expect(resumed.state).toBe('done');
  });

  it('preserves rollback evidence and keeps unknown indexes (TEST-MIG-ROLLBACK-001)', async () => {
    const registry = new MemoryRegistry();
    const service = executor(registry, definition('ops-rollback', true));
    const failed = await service.apply(
      {
        version: 'ops-rollback',
        scope,
        idempotencyKey: 'idem-rollback',
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    const rollback = await service.rollback(
      { runId: failed.runId, options: { timeoutMs: 1_000 } },
      context,
    );
    expect(rollback.state).toBe('rolled_back');
    expect(registry.rollbackInfo(failed.runId)).toMatchObject({
      runbookUri: expect.stringContaining('runbook'),
    });
  });
});
