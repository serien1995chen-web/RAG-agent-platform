import type { ClientSession, Connection } from 'mongoose';

/**
 * Mongo 多集合主数据变更的统一事务入口（设计文档 18.7）。
 * 失败不吞错、不重试业务错误；session 在 finally 中结束。
 */
export async function withMongoTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await connection.startSession();
  try {
    return await session.withTransaction(async () => work(session));
  } finally {
    await session.endSession();
  }
}
