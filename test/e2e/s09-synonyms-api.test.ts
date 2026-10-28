import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
  type TenantContext,
} from '../../packages/service/src';
import {
  rebuildResult,
  type SynonymStagedRebuild,
} from '../../packages/service/src/modules/knowledge/domain/s09-synonym-rebuild';
import { KnowledgeSynonymRepository } from '../../packages/service/src/modules/knowledge/repository/s09-synonym.repository';
import { apiHeaders, createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s9_api_${suffix}`;
const memberId = `mem_s9_api_${suffix}`;
const authToken = `kb-s9-api-token-${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req_s9_api_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let app: S4AppHarness;
let spaceId = '';
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
const repository = () => new KnowledgeSynonymRepository(connection);

function csv(standard: string, synonym: string): Uint8Array {
  return Buffer.from(`标准词,同义词\n${standard},${synonym}\n`);
}

function form(bytes: Uint8Array, input: { name?: string; expectedFileVersion?: number } = {}) {
  const body = new FormData();
  body.set(
    'file',
    new File([bytes], input.name ?? 'synonyms.csv', {
      type: 'text/csv',
    }),
  );
  body.set('enabled', 'true');
  if (input.expectedFileVersion !== undefined) {
    body.set('expectedFileVersion', String(input.expectedFileVersion));
  }
  return body;
}

async function upload(input: {
  path?: string;
  method?: 'POST' | 'PUT';
  idempotencyKey: string;
  bytes: Uint8Array;
  name?: string;
  expectedFileVersion?: number;
}) {
  const response = await fetch(`${app.baseUrl}/v1/knowledge/spaces/${spaceId}/synonyms/files`, {
    method: input.method ?? 'POST',
    headers: apiHeaders({
      authToken,
      workspaceId,
      idempotencyKey: input.idempotencyKey,
    }),
    body: form(input.bytes, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.expectedFileVersion !== undefined
        ? { expectedFileVersion: input.expectedFileVersion }
        : {}),
    }),
  });
  return {
    response,
    payload: (await response.json()) as {
      success: boolean;
      data?: { activeFileVersion: number; version: number };
      error?: { code: string };
    },
  };
}

async function completeLatestJob() {
  const models = registerKnowledgeModels(connection);
  const job = await models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'synonym_rebuild',
    status: 'queued',
  }).sort({ _id: -1 });
  expect(job).toBeTruthy();
  const fencingToken = randomUUID();
  await models.KnowledgeJob.updateOne(
    { _id: job!._id, workspaceId, status: 'queued' },
    {
      $set: {
        status: 'running',
        leaseOwner: `s9-api-${suffix}`,
        leaseExpiresAt: new Date(Date.now() + 300_000),
        fencingToken,
      },
      $inc: { version: 1, attemptEpoch: 1, attempts: 1 },
    },
  );
  const plan = await repository().getRebuildPlan(String(job!._id), context);
  const staged: SynonymStagedRebuild = {
    stagingId: `s9-api-stage-${job!._id}`,
    workspaceId,
    knowledgeSpaceId: plan.knowledgeSpaceId,
    candidateFileVersion: plan.candidateFileVersion,
    sourceIds: plan.sourceIds,
    indexedSegmentVersions: {},
    reusedVectorCount: 0,
    rebuiltCount: 0,
    cleanupCandidates: [],
    failureEvidence: null,
  };
  await repository().completeRebuild(plan, staged, rebuildResult(plan, staged), context);
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  try {
    spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  } catch (error) {
    throw new Error(`${String(error)}\n${app.output()}`);
  }
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? '');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
}, 180_000);

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await app?.close();
});

describe('S9 synonym HTTP multipart', () => {
  it('uploads, replays, updates and reports stale expectedFileVersion through the real handler', async () => {
    const firstBytes = csv('退款', '退货');
    const first = await upload({
      idempotencyKey: `s9-http-upload-${suffix}`,
      bytes: firstBytes,
    });
    expect(first.response.status, JSON.stringify(first.payload)).toBe(201);
    expect(first.payload.data).toMatchObject({ activeFileVersion: 1 });
    const replay = await upload({
      idempotencyKey: `s9-http-upload-${suffix}`,
      bytes: firstBytes,
    });
    expect(replay.response.status).toBe(201);
    expect(replay.payload.data).toEqual(first.payload.data);
    await completeLatestJob();

    const updated = await upload({
      method: 'PUT',
      idempotencyKey: `s9-http-update-${suffix}`,
      bytes: csv('配送', '发货'),
      expectedFileVersion: 1,
    });
    expect(updated.response.status).toBe(200);
    expect(updated.payload.data).toMatchObject({ activeFileVersion: 2 });

    const stale = await upload({
      method: 'PUT',
      idempotencyKey: `s9-http-stale-${suffix}`,
      bytes: csv('发票', '账单'),
      expectedFileVersion: 1,
    });
    expect(stale.response.status).toBe(409);
    expect(stale.payload.error?.code).toBe('KNOWLEDGE_CONFLICT');
  }, 60_000);

  it('enforces file and multipart limits before persistence', async () => {
    const invalid = await upload({
      idempotencyKey: `s9-http-invalid-${suffix}`,
      bytes: Buffer.from('foo,bar\nA,B\n'),
      name: 'invalid.csv',
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.payload.error?.code).toBe('KNOWLEDGE_SYNONYM_INVALID');

    const tenMiB = await upload({
      idempotencyKey: `s9-http-ten-mib-${suffix}`,
      bytes: Buffer.alloc(10 * 1024 * 1024, 0x20),
      name: 'ten-mib.csv',
    });
    expect(tenMiB.response.status, JSON.stringify(tenMiB.payload)).toBe(422);

    const tenMiBPlusOne = await upload({
      idempotencyKey: `s9-http-ten-mib-plus-${suffix}`,
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
      name: 'ten-mib-plus.csv',
    });
    expect(tenMiBPlusOne.response.status).toBe(413);

    const elevenMiBPlusOne = await upload({
      idempotencyKey: `s9-http-eleven-mib-plus-${suffix}`,
      bytes: Buffer.alloc(11 * 1024 * 1024 + 1, 0x20),
      name: 'eleven-mib-plus.csv',
    });
    expect(elevenMiBPlusOne.response.status).toBe(413);
  }, 120_000);
});
