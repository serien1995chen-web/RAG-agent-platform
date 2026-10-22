import type { KnowledgeRuntimeConfig } from '../config/knowledge-runtime-config';
import mongoose, { type Connection } from 'mongoose';
import Redis from 'ioredis';
import { Pool } from 'pg';

export interface KnowledgeConnections {
  mongo: Connection;
  redis: Redis;
  pg: Pool;
  close(): Promise<void>;
}

function mongoUriForRuntime(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    parsed.searchParams.set('directConnection', 'true');
  }
  return parsed.toString();
}

export async function createKnowledgeMongoConnection(uri: string): Promise<Connection> {
  const mongo = mongoose.createConnection(mongoUriForRuntime(uri), {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5_000,
  });
  await mongo.asPromise();
  return mongo;
}

export async function createKnowledgeConnections(
  config: KnowledgeRuntimeConfig,
): Promise<KnowledgeConnections> {
  const mongo = await createKnowledgeMongoConnection(config.mongoUri);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();
  const pg = new Pool({ connectionString: config.pgUrl, max: 20 });
  await pg.query('SELECT 1');
  let closed = false;
  return {
    mongo,
    redis,
    pg,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([mongo.close(), redis.quit(), pg.end()]);
    },
  };
}
