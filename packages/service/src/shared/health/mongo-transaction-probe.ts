import { ApiErrorException, createApiError } from '@kb/contracts';
import type { Connection } from 'mongoose';
import type { ProbeResult } from '../../ports/capabilities';

/**
 * ISSUE-003：Mongo 事务可用性探针。
 * 删除/对账依赖多文档事务；单机 Mongo 必须在启动期显式失败，
 * 而不是在第一次删除时以 501998 暴露。
 */
export async function checkMongoTransactions(connection: Connection): Promise<ProbeResult> {
  const startedAt = Date.now();
  const db = connection.db;
  if (!db) {
    throw new ApiErrorException(
      createApiError({
        code: 501016,
        requestId: 'mongo-transaction-probe',
        params: { store: 'mongo', operation: 'transaction_probe' },
      }),
    );
  }

  const hello = (await db.admin().command({ hello: 1 })) as {
    setName?: unknown;
    msg?: unknown;
  };
  const supported = typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
  if (!supported) {
    // 单机 Mongo 不支持事务：以既有依赖不可用错误码显式失败。
    throw new ApiErrorException(
      createApiError({
        code: 501016,
        requestId: 'mongo-transaction-probe',
        params: { store: 'mongo', operation: 'transactions_require_replica_set' },
      }),
    );
  }
  return { name: 'mongo-transactions', status: 'ok', durationMs: Date.now() - startedAt };
}

export const MONGO_TRANSACTION_PROBE_NAME = 'mongo-transactions';
