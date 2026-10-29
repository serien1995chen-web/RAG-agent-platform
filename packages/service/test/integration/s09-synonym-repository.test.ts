import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import {
  stableLogicalIds,
  validateMappings,
  type SynonymInputRow,
} from '../../src/modules/knowledge/domain/s09-synonym';
import {
  rebuildResult,
  type SynonymStagedRebuild,
} from '../../src/modules/knowledge/domain/s09-synonym-rebuild';
import { KnowledgeSynonymRepository } from '../../src/modules/knowledge/repository/s09-synonym.repository';
import { S7SearchRepository } from '../../src/modules/knowledge/repository/s7-search.repository';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import type { S09CreatePendingVersionInput } from '../../src/modules/knowledge/application/s09-synonym.ports';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s9_synonym_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s9_${suffix}`,
  requestId: `req_s9_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let repository: KnowledgeSynonymRepository;
let sourceId: string;

function rows(values: Array<[string, string[]]>): SynonymInputRow[] {
  return [
    {
      rowNumber: 1,
      cells: [
        { columnNumber: 1, value: '标准词' },
        { columnNumber: 2, value: '同义词' },
      ],
    },
    ...values.map(([standard, synonyms], index) => ({
      rowNumber: index + 2,
      cells: [
        { columnNumber: 1, value: standard },
        ...synonyms.map((value, synonymIndex) => ({
          columnNumber: synonymIndex + 2,
          value,
        })),
      ],
    })),
  ];
}

function mappings(values: Array<[string, string[]]>) {
  const validation = validateMappings(rows(values));
  if (!validation.ok) throw new Error(JSON.stringify(validation.diagnostics));
  return stableLogicalIds({
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    mappings: validation.mappings,
  });
}

function pendingInput(input: {
  checksum: string;
  idempotencyKey: string;
  expectedFileVersion?: number;
  values?: Array<[string, string[]]>;
}): S09CreatePendingVersionInput {
  return {
    ...(input.expectedFileVersion !== undefined
      ? { expectedFileVersion: input.expectedFileVersion }
      : {}),
    enabled: true,
    reason: 'synonym_change',
    fileName: `synonyms-${input.checksum.slice(0, 8)}.csv`,
    mimeType: 'text/csv',
    sizeBytes: 128,
    checksumSha256: input.checksum,
    mappings: mappings(
      input.values ?? [
        ['退款', ['退货']],
        ['配送', ['发货']],
      ],
    ),
    rawFile: {
      blobId: 'unused',
      provider: 'minio',
      bucket: 'kb-local',
      objectKey: `synonyms/${input.checksum}.csv`,
      mimeType: 'text/csv',
      sizeBytes: 128,
      etag: 'etag',
      sha256: input.checksum,
      originalName: 'synonyms.csv',
    },
    sourceIds: [sourceId],
    idempotencyKey: input.idempotencyKey,
    requestHash: createHash('sha256')
      .update(`${input.checksum}:${input.idempotencyKey}`)
      .digest('hex'),
  };
}

async function completeJob(jobId: string, _targetModelId = 'embedding-768') {
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeJob.updateOne(
    { _id: jobId, workspaceId, status: 'queued' },
    {
      $set: {
        status: 'running',
        leaseOwner: 's9-test',
        leaseExpiresAt: new Date(Date.now() + 300_000),
        fencingToken: randomUUID(),
      },
      $inc: { version: 1, attemptEpoch: 1, attempts: 1 },
    },
  );
  const plan = await repository.getRebuildPlan(jobId, context);
  const staged: SynonymStagedRebuild = {
    stagingId: `staging-${jobId}`,
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    candidateFileVersion: plan.candidateFileVersion,
    sourceIds: [sourceId],
    indexedSegmentVersions: { [`segment-${jobId}`]: 4 },
    reusedVectorCount: 1,
    rebuiltCount: 2,
    cleanupCandidates: [
      {
        vectorId: `vector-${plan.candidateFileVersion}`,
        dimension: 768,
        availableAt: new Date(Date.now() + 30 * 86_400_000),
      },
    ],
    failureEvidence: null,
  };
  await repository.completeRebuild(plan, staged, rebuildResult(plan, staged), context);
  return plan;
}

async function createSourceAndBinding() {
  const models = registerKnowledgeModels(connection);
  sourceId = String(new mongoose.Types.ObjectId());
  await models.KnowledgeSource.create({
    _id: sourceId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    directoryId: null,
    kind: 'text',
    name: 'synonym-source.txt',
    externalId: null,
    connectorId: null,
    blobRefId: new mongoose.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 10,
    contentHash: 'source-hash',
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: context.memberId,
    metadata: {},
    tagValues: [],
  });
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: null,
    activeQueryDimension: null,
    authorizedAt: new Date(),
  });
}

beforeAll(async () => {
  const mongoUri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (mongoUri.hostname === '127.0.0.1' || mongoUri.hostname === 'localhost') {
    mongoUri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(mongoUri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeSynonymRepository(connection);
}, 60_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('S9 synonym repository', () => {
  beforeEach(async () => {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await createSourceAndBinding();
  });

  it('TEST-TRAIN-006-BLOCK keeps immutable versions and serves only the published snapshot', async () => {
    const firstChecksum = createHash('sha256').update('first').digest('hex');
    const first = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum: firstChecksum,
        idempotencyKey: `upload-first-${suffix}`,
      }),
      context,
    );
    expect(first.replayed).toBe(false);
    expect(first.config.activeFileVersion).toBe(1);
    expect(first.job?.kind).toBe('synonym_rebuild');
    expect(await repository.getPublishedSnapshot(String(knowledgeSpaceId), context)).toBeNull();

    await completeJob(first.job!.jobId);
    const publishedV1 = await repository.getPublishedSnapshot(String(knowledgeSpaceId), context);
    expect(publishedV1?.fileVersion).toBe(1);
    expect(new Set(publishedV1?.mappings.map((mapping) => mapping.standardizedTerm))).toEqual(
      new Set(['配送', '退款']),
    );

    const secondChecksum = createHash('sha256').update('second').digest('hex');
    const second = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum: secondChecksum,
        idempotencyKey: `upload-second-${suffix}`,
        expectedFileVersion: 1,
        values: [
          ['退款', ['返还']],
          ['配送', ['发货']],
        ],
      }),
      context,
    );
    expect(second.config.activeFileVersion).toBe(2);
    expect(
      (await repository.getPublishedSnapshot(String(knowledgeSpaceId), context))?.fileVersion,
    ).toBe(1);

    await completeJob(second.job!.jobId);
    const publishedV2 = await repository.getPublishedSnapshot(String(knowledgeSpaceId), context);
    expect(publishedV2?.fileVersion).toBe(2);
    expect(
      publishedV2?.mappings.find((mapping) => mapping.standardizedTerm === '退款')?.synonymTerms,
    ).toEqual(['返还']);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeSynonymMapping.countDocuments({
        workspaceId,
        knowledgeSpaceId,
        fileVersion: 1,
      }),
    ).toBe(2);
    expect(
      await models.KnowledgeObjectRef.countDocuments({
        workspaceId,
        knowledgeSpaceId,
        purpose: 'synonym',
      }),
    ).toBe(2);
    await expect(
      repository.createPendingVersion(
        String(knowledgeSpaceId),
        pendingInput({
          checksum: firstChecksum,
          idempotencyKey: `stale-expected-${suffix}`,
          expectedFileVersion: 1,
        }),
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  }, 60_000);

  it('TEST-MODEL-002-BLOCK creates a model-change rebuild and switches the query profile atomically', async () => {
    const checksum = createHash('sha256').update('model-change').digest('hex');
    const first = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum,
        idempotencyKey: `model-change-initial-${suffix}`,
      }),
      context,
    );
    await completeJob(first.job!.jobId);
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeModelBinding.updateOne(
      {
        workspaceId,
        knowledgeSpaceId,
        modelType: 'embedding',
      },
      {
        $set: {
          modelId: 'mock-embedding-1024',
          displayName: 'Embedding 1024',
          requiredCapabilities: ['text-embedding', 'dimension:1024'],
          activeQueryModelId: 'mock-embedding-768',
          activeQueryDimension: 768,
        },
      },
    );
    const job = await connection.transaction((session) =>
      repository.requestModelChangeRebuildInSession(
        {
          spaceId: String(knowledgeSpaceId),
          targetModelId: 'mock-embedding-1024',
          targetDimension: 1024,
        },
        context,
        session,
      ),
    );
    expect(job).toMatchObject({
      kind: 'synonym_rebuild',
      status: 'queued',
      inputSnapshot: {
        reason: 'model_change',
        fileVersion: 1,
      },
    });
    const search = new S7SearchRepository(connection, new S5MockModelCatalog());
    await expect(
      search.resolveModels(String(knowledgeSpaceId), false, context),
    ).resolves.toMatchObject({
      embedding: { modelId: 'mock-embedding-768', dimension: 768 },
    });
    await completeJob(job!.jobId);
    await expect(
      search.resolveModels(String(knowledgeSpaceId), false, context),
    ).resolves.toMatchObject({
      embedding: { modelId: 'mock-embedding-1024', dimension: 1024 },
    });
  }, 60_000);

  it('TEST-TRAIN-006-BLOCK never rebinds a terminal manual rebuild job', async () => {
    const checksum = createHash('sha256').update('manual-rebuild').digest('hex');
    const created = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum,
        idempotencyKey: `manual-rebuild-initial-${suffix}`,
      }),
      context,
    );
    await completeJob(created.job!.jobId);

    const firstConfig = await repository.getConfig(String(knowledgeSpaceId), context);
    const firstManual = await repository.createManualRebuild(
      String(knowledgeSpaceId),
      { version: firstConfig.version },
      context,
    );
    await completeJob(firstManual.jobId);

    const completedConfig = await repository.getConfig(String(knowledgeSpaceId), context);
    const secondManual = await repository.createManualRebuild(
      String(knowledgeSpaceId),
      { version: completedConfig.version },
      context,
    );
    expect(secondManual.status).toBe('queued');
    expect(secondManual.jobId).not.toBe(firstManual.jobId);

    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: secondManual.jobId, workspaceId, status: 'queued' },
      {
        $set: {
          status: 'running',
          leaseOwner: 'manual-failure-worker',
          leaseExpiresAt: new Date(Date.now() + 300_000),
          fencingToken: randomUUID(),
        },
        $inc: { version: 1, attemptEpoch: 1, attempts: 1 },
      },
    );
    const failedPlan = await repository.getRebuildPlan(secondManual.jobId, context);
    await repository.failRebuild(
      failedPlan,
      {
        retryable: false,
        errorCode: 'KNOWLEDGE_INTERNAL_ERROR',
        failureEvidence: { stage: 'test_failure' },
      },
      context,
    );
    const failedConfig = await repository.getConfig(String(knowledgeSpaceId), context);
    expect(failedConfig).toMatchObject({ status: 'failed' });
    const thirdManual = await repository.createManualRebuild(
      String(knowledgeSpaceId),
      { version: failedConfig.version },
      context,
    );
    expect(thirdManual.status).toBe('queued');
    expect(thirdManual.jobId).not.toBe(secondManual.jobId);
    expect(await repository.getConfig(String(knowledgeSpaceId), context)).toMatchObject({
      status: 'rebuilding',
    });
  }, 60_000);

  it('TEST-SEARCH-003-BLOCK reuses checksum history and rejects idempotency body conflicts', async () => {
    const checksum = createHash('sha256').update('checksum').digest('hex');
    const key = `checksum-key-${suffix}`;
    const first = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({ checksum, idempotencyKey: key }),
      context,
    );
    await completeJob(first.job!.jobId);
    const replay = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum,
        idempotencyKey: `checksum-other-${suffix}`,
      }),
      context,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.config.activeFileVersion).toBe(1);
    await expect(
      repository.createPendingVersion(
        String(knowledgeSpaceId),
        pendingInput({
          checksum: createHash('sha256').update('different').digest('hex'),
          idempotencyKey: key,
        }),
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  }, 60_000);

  it('TEST-TRAIN-006-BLOCK rejects a stale worker during final synonym switch', async () => {
    const checksum = createHash('sha256').update('stale-worker').digest('hex');
    const created = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum,
        idempotencyKey: `stale-worker-key-${suffix}`,
      }),
      context,
    );
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: created.job!.jobId, workspaceId },
      {
        $set: {
          status: 'running',
          leaseOwner: 'worker-a',
          leaseExpiresAt: new Date(Date.now() + 300_000),
          fencingToken: 'fencing-a',
        },
        $inc: { version: 1, attemptEpoch: 1, attempts: 1 },
      },
    );
    const plan = await repository.getRebuildPlan(created.job!.jobId, context);
    await models.KnowledgeJob.updateOne(
      { _id: created.job!.jobId, workspaceId },
      { $set: { fencingToken: 'stale-replacement' } },
    );
    const staged: SynonymStagedRebuild = {
      stagingId: 'stale-staging',
      workspaceId,
      knowledgeSpaceId: String(knowledgeSpaceId),
      candidateFileVersion: plan.candidateFileVersion,
      sourceIds: [sourceId],
      indexedSegmentVersions: {},
      reusedVectorCount: 0,
      rebuiltCount: 1,
      cleanupCandidates: [],
      failureEvidence: null,
    };
    await expect(
      repository.completeRebuild(plan, staged, rebuildResult(plan, staged), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(await repository.getPublishedSnapshot(String(knowledgeSpaceId), context)).toBeNull();
  }, 60_000);

  it('TEST-AUTH-001-BLOCK applies CAS toggles, paginates mappings and preserves history on delete', async () => {
    const checksum = createHash('sha256').update('delete').digest('hex');
    const created = await repository.createPendingVersion(
      String(knowledgeSpaceId),
      pendingInput({
        checksum,
        idempotencyKey: `delete-key-${suffix}`,
      }),
      context,
    );
    await completeJob(created.job!.jobId);
    const firstPage = await repository.listMappings(
      String(knowledgeSpaceId),
      { limit: 1 },
      context,
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await repository.listMappings(
      String(knowledgeSpaceId),
      { limit: 1, cursor: firstPage.nextCursor! },
      context,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.logicalMappingId).not.toBe(firstPage.items[0]?.logicalMappingId);

    const current = await repository.getConfig(String(knowledgeSpaceId), context);
    const results = await Promise.allSettled([
      repository.toggle(
        String(knowledgeSpaceId),
        { enabled: false, version: current.version },
        context,
      ),
      repository.toggle(
        String(knowledgeSpaceId),
        { enabled: false, version: current.version },
        context,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const disabled = await repository.getConfig(String(knowledgeSpaceId), context);
    expect(disabled).toMatchObject({ status: 'disabled', enabled: false, activeFileVersion: 1 });
    expect(await repository.getPublishedSnapshot(String(knowledgeSpaceId), context)).toBeNull();
    await repository.toggle(
      String(knowledgeSpaceId),
      { enabled: true, version: disabled.version },
      context,
    );
    const enabled = await repository.getConfig(String(knowledgeSpaceId), context);
    await repository.disableAndDelete(
      String(knowledgeSpaceId),
      { version: enabled.version },
      context,
    );
    const deleted = await repository.getConfig(String(knowledgeSpaceId), context);
    expect(deleted).toMatchObject({
      enabled: false,
      status: 'disabled',
      activeFileVersion: 1,
    });
    const models = registerKnowledgeModels(connection);
    expect(
      (
        await models.KnowledgeSynonymConfig.findOne({
          workspaceId,
          knowledgeSpaceId,
        }).lean()
      )?.publishedFileVersion,
    ).toBeNull();
    expect(
      await repository.listMappings(String(knowledgeSpaceId), { limit: 10 }, context),
    ).toMatchObject({ fileVersion: 1, hasMore: false });
  }, 60_000);
});
