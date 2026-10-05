// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 本地最小 pg 类型声明（未登记 @types/pg）
/// <reference path="../../types/pg.d.ts" />
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import type { AppConfig } from '../config';

export interface InfrastructureClients {
  mongo: mongoose.Connection;
  redis: Redis;
  pg: Pool;
}

/** 连接池上限来自容量档案（设计文档 6.8），不在代码中写死。 */
export function createInfrastructureClients(config: AppConfig): InfrastructureClients {
  const mongo = mongoose.createConnection(config.system.mongoUri, {
    maxPoolSize: config.capacity.mongoPoolSize,
  });
  const redis = new Redis(config.system.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  const pg = new Pool({ connectionString: config.system.pgUrl, max: config.capacity.pgPoolSize });
  // 连接错误由探针与日志上报，未监听的 error 事件会导致进程崩溃。
  redis.on('error', () => undefined);
  pg.on('error', () => undefined);
  return { mongo, redis, pg };
}

export async function closeInfrastructureClients(clients: InfrastructureClients): Promise<void> {
  await Promise.allSettled([clients.mongo.close(), clients.redis.quit(), clients.pg.end()]);
}
