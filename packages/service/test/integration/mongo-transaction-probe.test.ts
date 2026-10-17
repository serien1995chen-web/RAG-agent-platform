import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMongoTransactions } from '../../src/shared/health';

/**
 * ISSUE-003：删除/对账依赖多文档事务。
 * 单机 Mongo 必须在启动探针处显式失败；单节点副本集通过。
 */
describe('mongo transaction probe (ISSUE-003)', () => {
  let standalone: MongoMemoryServer;
  let replica: MongoMemoryReplSet;
  let standaloneConn: mongoose.Connection;
  let replicaConn: mongoose.Connection;

  beforeAll(async () => {
    standalone = await MongoMemoryServer.create();
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    standaloneConn = mongoose.createConnection(standalone.getUri());
    replicaConn = mongoose.createConnection(replica.getUri());
    await standaloneConn.asPromise();
    await replicaConn.asPromise();
  }, 120_000);

  afterAll(async () => {
    await standaloneConn.close();
    await replicaConn.close();
    await standalone.stop();
    await replica.stop();
  });

  it('rejects a standalone mongod (no replica set)', async () => {
    await expect(checkMongoTransactions(standaloneConn)).rejects.toThrow(/501016/);
  });

  it('accepts a single-node replica set', async () => {
    const result = await checkMongoTransactions(replicaConn);
    expect(result).toMatchObject({ name: 'mongo-transactions', status: 'ok' });
  });
});
