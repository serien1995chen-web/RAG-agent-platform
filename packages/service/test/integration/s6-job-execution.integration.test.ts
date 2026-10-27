import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { KnowledgeCredentialCipher } from '../../src/modules/knowledge/adapter/credential-cipher';
import { KnowledgeConnectorRepository } from '../../src/modules/knowledge/repository/connector.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const sourceId = new mongoose.Types.ObjectId().toString();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_${suffix}`,
  requestId: `req_s6_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let repository: KnowledgeJobExecutionRepository;

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeJobExecutionRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('S6 Job execution repository', () => {
  it('creates Job and Outbox atomically with idempotent replay', async () => {
    const input = {
      kind: 'parse' as const,
      resourceType: 'source' as const,
      resourceId: sourceId,
      knowledgeSpaceId,
      inputSnapshot: { sourceVersion: 1, parseProvider: 'liteparse', configHash: 'cfg-1' },
      priority: 5,
      idempotencyKey: `s6-idem-${suffix}-parse`,
    };
    const first = await repository.create(input, context);
    const replay = await repository.create(input, context);
    expect(replay.jobId).toBe(first.jobId);
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
    await expect(
      repository.create(
        { ...input, inputSnapshot: { ...input.inputSnapshot, configHash: 'cfg-2' } },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  });

  it('claims with fencing, rejects stale versions and completes only with current token', async () => {
    const created = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: new mongoose.Types.ObjectId().toString(),
        knowledgeSpaceId,
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `s6-idem-${suffix}-index`,
      },
      context,
    );
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `worker-${suffix}` },
      context,
    );
    expect(claimed).not.toBeNull();
    const raw = await repository.getRaw(created.jobId, context);
    expect(raw.status).toBe('leased');
    expect(raw.fencingToken).not.toBe('unassigned');
    const running = await repository.start(
      created.jobId,
      claimed!.version,
      raw.attemptEpoch,
      raw.fencingToken,
      `worker-${suffix}`,
      context,
    );
    await expect(
      repository.commit(
        created.jobId,
        running.version,
        raw.attemptEpoch,
        'stale-token',
        `worker-${suffix}`,
        { fake: true },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    const completed = await repository.commit(
      created.jobId,
      running.version,
      raw.attemptEpoch,
      raw.fencingToken,
      `worker-${suffix}`,
      { indexed: true },
      context,
    );
    expect(completed.status).toBe('succeeded');
  });

  it('waits for every child and aggregates terminal results once', async () => {
    const root = await repository.create(
      {
        kind: 'rebuild',
        resourceType: 'source',
        resourceId: sourceId,
        knowledgeSpaceId,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          reason: 'manual',
          expectedSegmentVersions: [],
        },
        priority: 5,
        idempotencyKey: `s6-idem-${suffix}-root`,
      },
      context,
    );
    const child = await repository.createChild(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: new mongoose.Types.ObjectId().toString(),
        knowledgeSpaceId,
        inputSnapshot: { operation: 'reindex', segmentVersion: 1 },
        rootJobId: root.jobId,
        parentJobId: root.jobId,
        priority: 5,
        idempotencyKey: `s6-idem-${suffix}-child`,
      },
      context,
    );
    const claimedRoot = await repository.claimById(
      { jobId: root.jobId, kinds: ['rebuild'], workerId: `worker-${suffix}` },
      context,
    );
    const rawRoot = await repository.getRaw(root.jobId, context);
    await repository.start(
      root.jobId,
      claimedRoot!.version,
      rawRoot.attemptEpoch,
      rawRoot.fencingToken,
      `worker-${suffix}`,
      context,
    );
    await repository.releaseWaitingForChildren(root.jobId, [child.jobId], context);
    expect(await repository.aggregateRoot(root.jobId, context)).toBeNull();
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: child.jobId, workspaceId },
      { $set: { status: 'succeeded', result: { indexed: true } } },
    );
    const aggregate = await repository.aggregateRoot(root.jobId, context);
    expect(aggregate?.status).toBe('succeeded');
    expect(aggregate?.result?.partial).toBe(false);
    expect(aggregate?.result?.childJobIds).toContain(child.jobId);
  });

  it('finalizes nested waiting parents bottom-up only after all leaves are terminal', async () => {
    const root = await repository.create(
      {
        kind: 'rebuild',
        resourceType: 'space',
        resourceId: knowledgeSpaceId,
        knowledgeSpaceId,
        inputSnapshot: { sourceIds: [sourceId], reason: 'manual' },
        priority: 5,
        idempotencyKey: `s6-nested-root-${suffix}`,
      },
      context,
    );
    const sourceRebuild = await repository.createChild(
      {
        kind: 'rebuild',
        resourceType: 'source',
        resourceId: sourceId,
        knowledgeSpaceId,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          reason: 'manual',
          expectedSegmentVersions: [],
        },
        rootJobId: root.jobId,
        parentJobId: root.jobId,
        priority: 5,
        idempotencyKey: `s6-nested-source-${suffix}`,
      },
      context,
    );
    const index = await repository.createChild(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: new mongoose.Types.ObjectId().toString(),
        knowledgeSpaceId,
        inputSnapshot: { operation: 'reindex', sourceVersion: 1 },
        rootJobId: root.jobId,
        parentJobId: sourceRebuild.jobId,
        priority: 5,
        idempotencyKey: `s6-nested-index-${suffix}`,
      },
      context,
    );
    for (const [jobId, childJobIds] of [
      [root.jobId, [sourceRebuild.jobId]],
      [sourceRebuild.jobId, [index.jobId]],
    ] as const) {
      const claimed = await repository.claimById(
        {
          jobId,
          kinds: jobId === root.jobId ? ['rebuild'] : ['rebuild'],
          workerId: `worker-${suffix}`,
        },
        context,
      );
      const raw = await repository.getRaw(jobId, context);
      await repository.start(
        jobId,
        claimed!.version,
        raw.attemptEpoch,
        raw.fencingToken,
        `worker-${suffix}`,
        context,
      );
      await repository.releaseWaitingForChildren(jobId, [...childJobIds], context);
    }
    expect(await repository.aggregateRoot(root.jobId, context)).toBeNull();
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: index.jobId, workspaceId },
      { $set: { status: 'succeeded', result: { indexed: true } } },
    );
    expect((await repository.aggregateRoot(root.jobId, context))?.status).toBe('succeeded');
    expect((await repository.getRaw(sourceRebuild.jobId, context)).status).toBe('succeeded');
    expect((await repository.getRaw(root.jobId, context)).status).toBe('succeeded');
  });

  it('propagates a failed descendant even when an intermediate parse already succeeded', async () => {
    const models = registerKnowledgeModels(connection);
    const rootId = new mongoose.Types.ObjectId();
    const parseId = new mongoose.Types.ObjectId();
    const indexId = new mongoose.Types.ObjectId();
    const now = new Date();
    const common = {
      workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      priority: 5,
      attempts: 1,
      maxAttempts: 3,
      attemptEpoch: 1,
      fencingToken: 'fixture-token',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      availableAt: now,
      cancelRequestedAt: null,
      pausedAt: null,
      result: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
    await models.KnowledgeJob.create([
      {
        ...common,
        _id: rootId,
        kind: 'import',
        resourceType: 'job',
        resourceId: String(rootId),
        status: 'running',
        idempotencyKey: `s6-hidden-failure-root-${suffix}`,
        inputSnapshot: { sourceIds: [sourceId], requestHash: 'root' },
        progress: { stage: 'waiting_children', completed: 0, total: 1, percent: 0 },
        error: null,
      },
      {
        ...common,
        _id: parseId,
        kind: 'parse',
        resourceType: 'source',
        resourceId: sourceId,
        status: 'succeeded',
        idempotencyKey: `s6-hidden-failure-parse-${suffix}`,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          rootJobId: String(rootId),
          parentJobId: String(rootId),
        },
        progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
        error: null,
      },
      {
        ...common,
        _id: indexId,
        kind: 'index',
        resourceType: 'segment',
        resourceId: String(new mongoose.Types.ObjectId()),
        status: 'dead_letter',
        idempotencyKey: `s6-hidden-failure-index-${suffix}`,
        inputSnapshot: {
          operation: 'index',
          sourceVersion: 1,
          rootJobId: String(rootId),
          parentJobId: String(parseId),
        },
        progress: { stage: 'dead_letter', completed: 1, total: 1, percent: 100 },
        error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false },
      },
    ]);

    const aggregate = await repository.aggregateRoot(String(rootId), context);
    expect(aggregate?.status).toBe('dead_letter');
    expect(aggregate?.result?.partial).toBe(true);
    expect(aggregate?.error).toMatchObject({
      code: 'KNOWLEDGE_MODEL_FAILED',
      retryable: false,
    });
    expect(aggregate?.result?.sources).toEqual([
      expect.objectContaining({
        sourceId,
        status: 'dead_letter',
        errorCode: 'KNOWLEDGE_MODEL_FAILED',
        childJobIds: [String(indexId)],
      }),
    ]);
  });

  it('resets a failed sync connector when retrying a failed child Job', async () => {
    const models = registerKnowledgeModels(connection);
    const connectorSpaceId = new mongoose.Types.ObjectId();
    await models.KnowledgeSpace.create({
      _id: connectorSpaceId,
      workspaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'space',
      parentSpaceId: null,
      name: `S6 child retry ${suffix}`,
      description: '',
      iconKey: 'book-open',
      ownershipMemberId: context.memberId,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
      referenceRevision: 0,
      permissionRevision: 0,
      modelBindings: {},
      defaultChunking: {},
      status: 'active',
    });
    const connectorRepository = new KnowledgeConnectorRepository(
      connection,
      new KnowledgeCredentialCipher('c'.repeat(32)),
    );
    const connector = await connectorRepository.connect(
      String(connectorSpaceId),
      {
        provider: 'feishu',
        name: `S6 child retry ${suffix}`,
        credentials: { provider: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
        config: { provider: 'feishu', folderToken: 'folder-token' },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    const sync = await connectorRepository.markSyncing(
      connector.id,
      {
        full: false,
        requestHash: `s6-child-retry-${suffix}`,
        idempotencyKey: `s6-child-retry-${suffix}`,
      },
      context,
    );
    const child = await repository.createChild(
      {
        kind: 'parse',
        resourceType: 'source',
        resourceId: String(new mongoose.Types.ObjectId()),
        knowledgeSpaceId: String(connectorSpaceId),
        inputSnapshot: {
          sourceId: String(new mongoose.Types.ObjectId()),
          sourceVersion: 1,
          parseProvider: 'liteparse',
          configHash: 'cfg',
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        rootJobId: sync.job.jobId,
        parentJobId: sync.job.jobId,
        priority: 5,
        idempotencyKey: `s6-child-retry-parse-${suffix}`,
      },
      context,
    );
    await models.KnowledgeJob.updateMany(
      { _id: { $in: [sync.job.jobId, child.jobId] }, workspaceId },
      {
        $set: {
          status: 'failed',
          error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false },
        },
      },
    );
    await connectorRepository.completeSync(
      {
        connectorId: connector.id,
        success: false,
        errorCode: 'KNOWLEDGE_MODEL_FAILED',
      },
      context,
    );
    expect((await connectorRepository.get(connector.id, context)).status).toBe('failed');

    const failedChild = await repository.getRaw(child.jobId, context);
    const retried = await repository.control('retry', child.jobId, failedChild.version, context);
    expect(retried.status).toBe('queued');
    expect((await repository.getRaw(sync.job.jobId, context)).status).toBe('queued');
    expect((await connectorRepository.get(connector.id, context)).status).toBe('syncing');
    expect((await connectorRepository.get(connector.id, context)).lastError).toBeNull();
  });

  it('retries a failed Job and replays a failed root with all failed descendants', async () => {
    const retryJob = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: new mongoose.Types.ObjectId().toString(),
        knowledgeSpaceId,
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `s6-retry-${suffix}`,
      },
      context,
    );
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: retryJob.jobId, workspaceId },
      { $set: { maxAttempts: 1 } },
    );
    const retryClaim = await repository.claimById(
      { jobId: retryJob.jobId, kinds: ['index'], workerId: `retry-worker-${suffix}` },
      context,
    );
    const retryRaw = await repository.getRaw(retryJob.jobId, context);
    const retryRunning = await repository.start(
      retryJob.jobId,
      retryClaim!.version,
      retryRaw.attemptEpoch,
      retryRaw.fencingToken,
      `retry-worker-${suffix}`,
      context,
    );
    await repository.setStep(
      {
        jobId: retryJob.jobId,
        stepKey: 'embed',
        status: 'failed',
        idempotencyKey: `embed:${retryJob.jobId}`,
        error: { code: 'KNOWLEDGE_MODEL_FAILED' },
      },
      context,
    );
    const failed = await repository.fail(
      retryJob.jobId,
      retryRunning.version,
      retryRaw.attemptEpoch,
      retryRaw.fencingToken,
      `retry-worker-${suffix}`,
      false,
      'KNOWLEDGE_MODEL_FAILED',
      context,
    );
    expect(failed.status).toBe('dead_letter');
    const retryQueued = await repository.control('retry', retryJob.jobId, failed.version, context);
    expect(retryQueued.status).toBe('queued');
    expect(retryQueued.attemptEpoch).toBeGreaterThan(failed.attemptEpoch);
    expect(retryQueued.error).toBeNull();
    expect(
      await models.KnowledgeJobStep.countDocuments({
        workspaceId,
        jobId: retryJob.jobId,
        stepKey: 'embed',
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: retryJob.jobId,
        eventType: 'index.job.requeued',
      }),
    ).toBe(1);

    const root = await repository.create(
      {
        kind: 'rebuild',
        resourceType: 'source',
        resourceId: sourceId,
        knowledgeSpaceId,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          reason: 'manual',
          expectedSegmentVersions: [],
        },
        priority: 5,
        idempotencyKey: `s6-replay-root-${suffix}`,
      },
      context,
    );
    const child = await repository.createChild(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: new mongoose.Types.ObjectId().toString(),
        knowledgeSpaceId,
        inputSnapshot: { operation: 'reindex', sourceVersion: 1 },
        rootJobId: root.jobId,
        parentJobId: root.jobId,
        priority: 5,
        idempotencyKey: `s6-replay-child-${suffix}`,
      },
      context,
    );
    const rootClaim = await repository.claimById(
      { jobId: root.jobId, kinds: ['rebuild'], workerId: `root-worker-${suffix}` },
      context,
    );
    const rootRaw = await repository.getRaw(root.jobId, context);
    await repository.start(
      root.jobId,
      rootClaim!.version,
      rootRaw.attemptEpoch,
      rootRaw.fencingToken,
      `root-worker-${suffix}`,
      context,
    );
    await repository.releaseWaitingForChildren(root.jobId, [child.jobId], context);
    await models.KnowledgeJob.updateOne(
      { _id: child.jobId, workspaceId },
      { $set: { status: 'dead_letter', error: { code: 'KNOWLEDGE_JOB_FAILED' } } },
    );
    const deadRoot = await repository.aggregateRoot(root.jobId, context);
    expect(deadRoot?.status).toBe('dead_letter');
    const replayRoot = await repository.control('replay', root.jobId, deadRoot!.version, context);
    expect(replayRoot.status).toBe('queued');
    expect(replayRoot.result?.replayHistory).toHaveLength(1);
    const replayedChild = await repository.getRaw(child.jobId, context);
    expect(replayedChild.status).toBe('queued');
    expect(replayedChild.error).toBeNull();
    expect(replayedChild.result?.replayHistory).toHaveLength(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: { $in: [root.jobId, child.jobId] },
        eventType: { $in: ['rebuild.job.requeued', 'index.job.requeued'] },
      }),
    ).toBeGreaterThanOrEqual(2);
  });
});
