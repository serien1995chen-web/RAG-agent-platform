import { createUnimplementedPort } from '../../../ports/defaults';
import type { FullTextStore, VectorController } from '../../../ports/capabilities';
import type { Connection } from 'mongoose';
import type { Pool } from 'pg';
import { createFullTextStoreAdapter } from './full-text-store.adapter';
import { createVectorControllerAdapter } from './vector-controller.adapter';

export type KnowledgeItemIndexAdapters = VectorController & { fullText?: FullTextStore };

/**
 * 既有工厂名的 P2-17 装配窗口：无参数时保持 501999 默认语义；
 * 注入连接后返回真实 VectorController，并在可用时附带同一索引域的 FullTextStore。
 */
export function createKnowledgeItemIndexAdapter(options?: {
  pool?: Pool;
  connection?: Connection;
}): KnowledgeItemIndexAdapters {
  const vector = options?.pool
    ? createVectorControllerAdapter(options.pool)
    : createUnimplementedPort<VectorController>('VectorController-adapter');
  const fullText = options?.connection ? createFullTextStoreAdapter(options.connection) : undefined;
  return {
    insert: (input, context) => vector.insert(input, context),
    delete: (input, context) => vector.delete(input, context),
    embRecall: (input, context) => vector.embRecall(input, context),
    getVectorDataByTime: (input, context) => vector.getVectorDataByTime(input, context),
    getVectorCount: (input, context) => vector.getVectorCount(input, context),
    ...(fullText ? { fullText } : {}),
  };
}
