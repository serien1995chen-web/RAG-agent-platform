import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeError } from '@kb/contracts';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import type {
  S6SegmentRecord,
  S6SourceRecord,
} from '../../src/modules/knowledge/application/s06-processing-ports';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_failure_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const rootJobId = new mongoose.Types.ObjectId();
const sourceId = new mongoose.Types.ObjectId();
const segmentId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_failure_${suffix}`,
  requestId: `req_s6_failure_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let jobs: KnowledgeJobExecutionRepository;
let source: S6SourceRecord;
let segment: S6SegmentRecord;

function parseFixture() {
  return {
    format: 'text',
    rawText: 'Failure propagation fixture text.',
    pages: [
      {
        pageNumber: 1,
        text: 'Failure propagation fixture text.',
        assets: [],
      },
    ],
    assets: [],
    diagnostics: [],
    scanRequired: false,
    imageRefs: [],
    contentHash: 'sha256:fixture',
    parserVersion: 'fixture-parser@1',
    configHash: 'fixture-config',
  };
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
  jobs = new KnowledgeJobExecutionRepository(connection);
  source = {
    id: String(sourceId),
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    sourceVersion: 1,
    blobRefId: String(new mongoose.Types.ObjectId()),
    name: 'failure.txt',
    mimeType: 'text/plain',
    parseProvider: 'liteparse',
    searchEnabled: true,
    processingStatus: 'parsing',
    version: 1,
  };
  segment = {
    id: String(segmentId),
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    sourceId: String(sourceId),
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'Failure propagation fixture text.',
    answer: 'Failure propagation fixture text.',
    content: 'Failure propagation fixture text.',
    fullTextTokens: '',
    fullTextVersion: 0,
    metadata: {},
    history: [],
    indexes: [],
    indexStatus: 'pending',
    indexErrorCode: null,
    version: 1,
  };
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('S6 processing failure propagation', () => {
  it('waits for index descendants and fails the import root with per-source evidence', async () => {
    const models = registerKnowledgeModels(connection);
    const now = new Date();
    await models.KnowledgeJob.create({
      _id: rootJobId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'import',
      resourceType: 'job',
      resourceId: String(rootJobId),
      status: 'queued',
      priority: 5,
      idempotencyKey: `s6-failure-root-${suffix}`,
      inputSnapshot: {
        sourceIds: [String(sourceId)],
        configurationHash: 'cfg',
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        requestHash: 'request-hash',
      },
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      attempts: 0,
      maxAttempts: 3,
      attemptEpoch: 0,
      fencingToken: 'unassigned',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: now,
      cancelRequestedAt: null,
      pausedAt: null,
      error: null,
      result: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    const parse = await jobs.createChild(
      {
        kind: 'parse',
        resourceType: 'source',
        resourceId: String(sourceId),
        knowledgeSpaceId: String(knowledgeSpaceId),
        inputSnapshot: {
          sourceId: String(sourceId),
          sourceVersion: 1,
          parseProvider: 'liteparse',
          configHash: 'cfg',
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
          rootJobId: String(rootJobId),
          parentJobId: String(rootJobId),
        },
        rootJobId: String(rootJobId),
        parentJobId: String(rootJobId),
        priority: 5,
        idempotencyKey: `s6-failure-parse-${suffix}`,
      },
      context,
    );
    const claimedRoot = await jobs.claimById(
      { jobId: String(rootJobId), kinds: ['import'], workerId: `root-${suffix}` },
      context,
    );
    const rawRoot = await jobs.getRaw(String(rootJobId), context);
    await jobs.start(
      String(rootJobId),
      claimedRoot!.version,
      rawRoot.attemptEpoch,
      rawRoot.fencingToken,
      `root-${suffix}`,
      context,
    );
    await jobs.releaseWaitingForChildren(String(rootJobId), [parse.jobId], context);

    const processing = new S06ProcessingApplication({
      jobs,
      store: {
        async getSource() {
          return source;
        },
        async getSegment() {
          return segment;
        },
        async listSegmentsBySource() {
          return [segment];
        },
        async listActiveWorkspaceSegments() {
          return [segment];
        },
        async updateSourcesStatus(_sourceIds, status) {
          source = { ...source, processingStatus: status };
        },
        async updateSourceStatus(_sourceId, status) {
          source = { ...source, processingStatus: status };
        },
        async upsertParsedSegments() {
          return [segment.id];
        },
        async softDeleteSegmentsAfterOrder() {},
        async markIndexFailure(_segmentId, errorCode) {
          segment = {
            ...segment,
            indexStatus: 'error',
            indexErrorCode: errorCode,
            version: segment.version + 1,
          };
        },
        async removeSegmentIndex() {
          return segment;
        },
        async switchSegmentIndex() {
          return segment;
        },
        async updateSegmentQa() {
          return segment;
        },
        async softDeleteSegments() {
          return 0;
        },
      },
      artifacts: {
        async materialize(input) {
          return {
            sourceVersion: input.sourceVersion,
            rawTextObjectRef: {
              blobId: String(new mongoose.Types.ObjectId()),
              objectKey: `ws/${workspaceId}/source/${sourceId}/raw.txt`,
              purpose: 'source',
              sha256: createHash('sha256').update(input.parse.rawText).digest('hex'),
              sizeBytes: Buffer.byteLength(input.parse.rawText),
            },
            pages: input.parse.pages,
            assets: input.parse.assets,
            diagnostics: input.parse.diagnostics,
            evidence: {
              parserName: 'fixture',
              parserVersion: input.parse.parserVersion,
              providerConfigHash: input.parse.configHash,
              rawTextHash: input.parse.contentHash,
            },
          };
        },
      },
      processing: new S5ProcessingApplication(),
      vectors: {
        async insert() {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_MODEL_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: false,
            details: { reason: 'fixture_index_failure' },
          });
        },
        async deleteBySegment() {
          return { deleted: 0 };
        },
        listProfiles() {
          return [
            {
              tableName: 'knowledge_segment_vectors_768',
              storageType: 'vector',
              dimension: 768,
            },
          ];
        },
        async cleanupUnreferenced() {
          return { deleted: 0, byProfile: {} };
        },
      },
      fulltext: {
        async project() {
          throw new Error('fulltext should not run after vector failure');
        },
      },
      models: {
        async listModels() {
          return [
            {
              modelId: 's6-embedding-768',
              displayName: 'S6 embedding',
              type: 'embedding',
              capabilities: ['text-embedding', 'dimension:768'],
              dimension: 768,
              authorized: true,
            },
          ];
        },
      },
      bindings: {
        async list() {
          return [
            {
              modelType: 'embedding',
              modelId: 's6-embedding-768',
              displayName: 'S6 embedding',
              requiredCapabilities: ['text-embedding', 'dimension:768'],
              status: 'active',
            },
          ];
        },
      },
      port: {
        async parse() {
          return parseFixture();
        },
        async embed() {
          return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
        },
        async dispatchOutbox() {
          return false;
        },
      },
    });

    expect(
      await processing.handleQueue('knowledge-parse', parse.jobId, `parse-${suffix}`, context),
    ).toBe('succeeded');
    const waitingParse = await jobs.getRaw(parse.jobId, context);
    expect(waitingParse.status).toBe('running');
    expect(waitingParse.progress.stage).toBe('waiting_children');
    const index = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'index',
      'inputSnapshot.rootJobId': String(rootJobId),
      'inputSnapshot.parentJobId': parse.jobId,
    }).lean();
    expect(index).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(index!._id),
        `index-${suffix}`,
        context,
      ),
    ).toBe('retry');

    const root = await jobs.getRaw(String(rootJobId), context);
    const finalizedParse = await jobs.getRaw(parse.jobId, context);
    expect(root.status).toBe('failed');
    expect(root.error).toMatchObject({
      code: 'KNOWLEDGE_MODEL_FAILED',
      retryable: false,
    });
    expect(root.result?.partial).toBe(true);
    expect(finalizedParse.status).toBe('failed');
    expect(root.result?.sources).toEqual([
      expect.objectContaining({
        sourceId: String(sourceId),
        status: 'failed',
        errorCode: 'KNOWLEDGE_MODEL_FAILED',
        childJobIds: [String(index!._id)],
      }),
    ]);
    expect(source.processingStatus).toBe('partial');
    expect(segment.indexStatus).toBe('error');
    expect(segment.indexErrorCode).toBe('KNOWLEDGE_MODEL_FAILED');
  }, 60_000);
});
