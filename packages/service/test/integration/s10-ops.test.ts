import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { S10OperationsRepository } from '../../src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeAuditRepository } from '../../src/shared/persistence/knowledge/audit';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import { ensureKnowledgeCollections } from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_ops_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s10_ops_${suffix}`,
  requestId: `req_s10_ops_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: mongoose.Connection;
let repository: S10OperationsRepository;
let audits: KnowledgeAuditRepository;
const enqueue = vi.fn(async () => ({ id: 'queue' }));

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  repository = new S10OperationsRepository(connection, { enqueue } as never);
  audits = new KnowledgeAuditRepository(connection);
}, 60_000);

beforeEach(async () => {
  enqueue.mockClear();
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

describe('TEST-OPS-003-BLOCK / TEST-OPS-004-BLOCK operations', () => {
  it('queries append-only audit summaries with filters and cursor metadata', async () => {
    await audits.appendStandalone(
      {
        knowledgeSpaceId: null,
        action: 'api_key.create',
        resourceType: 'api_key',
        resourceId: '65f1e5b2a1c9d4b7e8f01234',
        outcome: 'succeeded',
        safeDiff: {
          keyPrefix: 'kn_live_abc',
          secret: 'must-not-be-stored',
          objectKey: 'must-not-be-stored',
        },
      },
      context,
    );
    const page = await repository.list({ action: 'api_key.create', limit: 10 }, context);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      workspaceId,
      action: 'api_key.create',
      actorMemberId: context.memberId,
      outcome: 'succeeded',
    });
    expect(JSON.stringify(page.items[0])).not.toContain('must-not-be-stored');
    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  it('creates cleanup/reconcile jobs and replay work with idempotent CAS boundaries', async () => {
    const idempotencyKey = `s10-ops-${suffix}-0001`.padEnd(16, '0');
    const cleanup = await repository.createCleanupJob({ scope: 'all', idempotencyKey }, context);
    expect(cleanup).toMatchObject({
      workspaceId,
      knowledgeSpaceId: '000000000000000000000000',
      kind: 'cleanup',
      status: 'queued',
      operationId: 'API-OPS-CLEANUP',
      priority: 5,
      attempts: 0,
      maxAttempts: 5,
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      resourceType: 'workspace',
      resourceId: '000000000000000000000000',
      version: 1,
    });
    expect(cleanup.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cleanup.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(enqueue).toHaveBeenCalledWith(
      'knowledge-cleanup',
      expect.stringMatching(/^k_[a-f0-9]{40}$/),
      expect.objectContaining({ jobId: cleanup.jobId, workspaceId }),
      expect.objectContaining({ attempts: 5 }),
    );

    const reconcile = await repository.createReconcileJob(
      {
        scope: 'outbox',
        repair: false,
        idempotencyKey: `${idempotencyKey}-r`.padEnd(16, '0'),
      },
      context,
    );
    expect(reconcile.kind).toBe('reconcile');
    expect(reconcile.operationId).toBe('API-OPS-RECONCILE');

    const models = registerKnowledgeModels(connection);
    const [event] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId,
        knowledgeSpaceId: null,
        version: 3,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: `event-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `usage-${suffix}`,
        payload: { queue: 'knowledge-outbox' },
        status: 'failed',
        attempts: 2,
        availableAt: new Date(),
        publishedAt: null,
        error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const result = await repository.replayOutbox(
      {
        eventId: String(event!._id),
        version: 3,
        idempotencyKey: `${idempotencyKey}-o`.padEnd(16, '0'),
      },
      context,
    );
    expect(result).toMatchObject({ id: String(event!._id), status: 'accepted' });
    const replayed = await models.KnowledgeOutboxEvent.findById(event!._id).lean();
    expect(replayed?.status).toBe('pending');
    expect(replayed?.version).toBe(4);
    await expect(
      repository.replayOutbox(
        {
          eventId: String(event!._id),
          version: 3,
          idempotencyKey: `${idempotencyKey}-x`.padEnd(16, '0'),
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });

  it('TEST-S10-REPLAY-CAS allows one concurrent outbox replay winner', async () => {
    const models = registerKnowledgeModels(connection);
    const [event] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId,
        knowledgeSpaceId: null,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: `event-cas-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `usage-cas-${suffix}`,
        payload: { queue: 'knowledge-outbox' },
        status: 'dead_letter',
        attempts: 10,
        availableAt: new Date(),
        publishedAt: null,
        error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const results = await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        repository
          .replayOutbox(
            {
              eventId: String(event!._id),
              version: 1,
              idempotencyKey: `replay-cas-${suffix}-${index}`.padEnd(16, '0'),
            },
            context,
          )
          .then(() => 'pass' as const)
          .catch((error: unknown) => {
            expect(error).toMatchObject({
              problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
            });
            return 'conflict' as const;
          }),
      ),
    );
    expect(results.filter((value) => value === 'pass')).toHaveLength(1);
    expect(results.filter((value) => value === 'conflict')).toHaveLength(1);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'outbox',
        resourceId: String(event!._id),
      }),
    ).toBe(1);
  });
});
