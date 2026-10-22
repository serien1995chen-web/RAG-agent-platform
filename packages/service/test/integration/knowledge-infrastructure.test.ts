import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqQueueAdapter, KNOWLEDGE_QUEUE_NAMES, buildKnowledgeJobId } from '@kb/dal';
import {
  MinioKnowledgeObjectStore,
  knowledgeObjectKey,
  type KnowledgeObjectContext,
  type KnowledgeObjectRef,
} from '../../../../sdk/storage/src/index';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../src/shared/persistence/schemas/knowledge-index';
import {
  KNOWLEDGE_VECTOR_PROFILES,
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import {
  KnowledgeOutboxDispatcher,
  createKnowledgeOutboxEvent,
} from '../../src/shared/persistence/knowledge/outbox';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_it_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const memberId = `mem_it_${suffix}`;
const redisPrefix = `kb-it-${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-it-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let redis: Redis;
let pool: Pool;
let queueAdapter: BullMqQueueAdapter;
let objectStore: MinioKnowledgeObjectStore;
let bucket: string;

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

  redis = new Redis(requiredEnv('KB_TEST_REDIS_URL'), { maxRetriesPerRequest: null });
  queueAdapter = new BullMqQueueAdapter({ connection: redis, prefix: redisPrefix });

  pool = new Pool({ connectionString: requiredEnv('KB_TEST_PG_URL'), max: 4 });
  await ensurePgvectorDdl(pool);

  const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
  bucket = requiredEnv('KB_TEST_S3_BUCKET');
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket,
  });
}, 60_000);

afterAll(async () => {
  if (queueAdapter) await queueAdapter.close();
  if (redis) {
    const keys = await redis.keys(`${redisPrefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }
  if (pool) {
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [workspaceId]);
    }
    await pool.end();
  }
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('knowledge architecture infrastructure', () => {
  it('creates exactly 23 canonical Mongo collections and declared indexes', async () => {
    const db = connection.db;
    expect(db).toBeDefined();
    const names = (await db!.listCollections({}, { nameOnly: true }).toArray()).map(
      (entry) => entry.name,
    );
    const knowledgeNames = names.filter((name) => name.startsWith('knowledge_')).sort();
    expect(knowledgeNames).toEqual(
      KNOWLEDGE_SCHEMA_REGISTRY.map((entry) => entry.collection).sort(),
    );
    expect(knowledgeNames).toHaveLength(23);
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const indexes = await db!.collection(entry.collection).indexes();
      expect(indexes.length, entry.collection).toBeGreaterThan(1);
    }
  });

  it('creates four pgvector profiles, HNSW indexes and accepts only matching dimensions', async () => {
    const profiles = await pool.query<{
      embedding_model_id: string;
      dimension: number;
      storage_type: string;
      table_name: string;
      status: string;
    }>(
      `SELECT embedding_model_id, dimension, storage_type, table_name, status
       FROM knowledge_vector_profiles
       WHERE profile_id = ANY($1::text[])
       ORDER BY dimension`,
      [KNOWLEDGE_VECTOR_PROFILES.map((profile) => profile.profileId)],
    );
    expect(profiles.rows).toHaveLength(4);
    expect(profiles.rows.map((row) => [row.dimension, row.storage_type])).toEqual([
      [768, 'vector'],
      [1024, 'vector'],
      [1536, 'vector'],
      [3072, 'halfvec'],
    ]);
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = ANY($1::text[]) AND indexname LIKE '%_hnsw'`,
      [KNOWLEDGE_VECTOR_PROFILES.map((profile) => profile.tableName)],
    );
    expect(indexes.rows).toHaveLength(4);
    expect(indexes.rows.some((row) => row.indexdef.includes('halfvec_cosine_ops'))).toBe(true);

    const repository = new KnowledgeVectorRepository(pool);
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      const vector = Array.from({ length: profile.dimension }, (_, index) => (index === 0 ? 1 : 0));
      const result = await repository.insert(
        [
          {
            workspaceId,
            knowledgeSpaceId: String(knowledgeSpaceId),
            sourceId: new mongoose.Types.ObjectId().toString(),
            segmentId: new mongoose.Types.ObjectId().toString(),
            indexId: `idx-${profile.dimension}`,
            embeddingModelId: `mock-embedding-${profile.dimension}`,
            dimension: profile.dimension,
            vector,
            searchEnabled: true,
            contentHash: createHash('sha256').update(String(profile.dimension)).digest('hex'),
            version: 1,
          },
        ],
        context,
      );
      expect(result.inserted).toBe(1);
    }
    await expect(
      repository.insert(
        [
          {
            workspaceId,
            knowledgeSpaceId: String(knowledgeSpaceId),
            sourceId: new mongoose.Types.ObjectId().toString(),
            segmentId: new mongoose.Types.ObjectId().toString(),
            indexId: 'idx-wrong',
            embeddingModelId: 'mock-embedding-768',
            dimension: 768,
            vector: [1, 0],
            searchEnabled: true,
            contentHash: 'wrong',
            version: 1,
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
  });

  it('creates 13 BullMQ queues with stable ids and retention', async () => {
    const jobs = [];
    for (const queueName of KNOWLEDGE_QUEUE_NAMES) {
      const jobId = buildKnowledgeJobId({
        kind: queueName,
        resourceId: workspaceId,
        version: 1,
        inputHash: createHash('sha256').update(queueName).digest('hex'),
      });
      expect(jobId).toMatch(/^k_[0-9a-f]{40}$/);
      const first = await queueAdapter.enqueue(queueName, jobId, { queueName });
      const second = await queueAdapter.enqueue(queueName, jobId, { queueName });
      expect(first.enqueued).toBe(true);
      expect(second.enqueued).toBe(false);
      const queue = new Queue(queueName, { connection: redis, prefix: redisPrefix });
      const job = await queue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.opts.removeOnComplete).toEqual({ count: 1000, age: 604800 });
      expect(job?.opts.removeOnFail).toBe(false);
      await job?.remove();
      await queue.close();
      jobs.push(jobId);
    }
    expect(jobs).toHaveLength(13);
  });

  it('writes outbox only inside a Mongo transaction and dispatches idempotently', async () => {
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await createKnowledgeOutboxEvent(
          connection,
          {
            workspaceId,
            knowledgeSpaceId: String(knowledgeSpaceId),
            eventType: 'delete',
            aggregateType: 'source',
            aggregateId: `src_${suffix}`,
            queue: 'knowledge-delete',
            payload: { sourceId: `src_${suffix}`, resourceVersion: 1 },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    const dispatcher = new KnowledgeOutboxDispatcher(connection, queueAdapter);
    const first = await dispatcher.dispatchOnce(context);
    const second = await dispatcher.dispatchOnce(context);
    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    const event = await connection.models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      status: 'published',
    });
    expect(event).not.toBeNull();
  });

  it('stores non-secret MinIO objects under workspace/space scoped keys', async () => {
    const objectContext: KnowledgeObjectContext = {
      workspaceId,
      knowledgeSpaceId: String(knowledgeSpaceId),
      requestId: context.requestId,
      traceId: context.traceId,
    };
    const key = knowledgeObjectKey({
      workspaceId,
      knowledgeSpaceId: String(knowledgeSpaceId),
      sourceId: `src_${suffix}`,
      purpose: 'source',
      blobId: `blob_${suffix}`,
      safeName: 'acceptance.txt',
    });
    const body = new TextEncoder().encode('knowledge architecture baseline');
    const stored = await objectStore.put(
      {
        key,
        workspaceId,
        knowledgeSpaceId: String(knowledgeSpaceId),
        body,
        contentType: 'text/plain',
      },
      objectContext,
    );
    const loaded = await objectStore.get(stored, objectContext);
    expect(Buffer.from(loaded.body).toString()).toBe('knowledge architecture baseline');
    const wrongContext = { ...objectContext, workspaceId: `ws_other_${suffix}` };
    await expect(objectStore.get(stored as KnowledgeObjectRef, wrongContext)).rejects.toMatchObject(
      {
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      },
    );
    await objectStore.delete(stored, objectContext);
  });
});
