import { ApiErrorException, createSkeletonError } from '@kb/contracts';
import type { IndexOptions, Schema } from 'mongoose';

/**
 * 索引声明登记（设计文档 18.8 / SKEL-ADR-004）。
 * 所有 Schema 必须通过 defineIndex(schema, { key, options, deprecated }) 声明索引；
 * 禁止在 Schema 字段上使用 index/unique，禁止直接调用 schema.index()。
 * 启动时索引管理器只补建缺失索引，不自动删除未登记索引。
 */
export interface IndexDeclaration {
  name: string;
  key: Record<string, 1 | -1 | 'text' | 'hashed'>;
  options?: IndexOptions & { default_language?: string };
  deprecated?: boolean;
}

const INDEX_REGISTRY = new Map<Schema<unknown>, IndexDeclaration[]>();

export function defineIndex<TSchema>(
  schema: Schema<TSchema>,
  declaration: IndexDeclaration,
): IndexDeclaration {
  const registered = schema as unknown as Schema<unknown>;
  const entries = INDEX_REGISTRY.get(registered) ?? [];
  if (entries.some((entry) => entry.name === declaration.name)) {
    throw new ApiErrorException(
      createSkeletonError({ operation: `defineIndex:${declaration.name}` }, 'registry'),
    );
  }
  schema.index(declaration.key, { ...declaration.options, name: declaration.name });
  INDEX_REGISTRY.set(registered, [...entries, declaration]);
  return declaration;
}

export function getDeclaredIndexes(schema: Schema<unknown>): readonly IndexDeclaration[] {
  return INDEX_REGISTRY.get(schema) ?? [];
}

export function listDeclaredIndexes(): ReadonlyMap<Schema<unknown>, readonly IndexDeclaration[]> {
  return INDEX_REGISTRY;
}

export function collectionNameOf(schema: Schema<unknown>): string {
  return (schema.get('collection') as string | undefined) ?? 'unnamed';
}
