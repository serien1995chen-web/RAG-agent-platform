import { ApiErrorException, createSkeletonError } from '@kb/contracts';

/**
 * 索引声明登记表（设计文档 18.8 / SKEL-ADR-004）。
 * 所有 Schema 必须通过 defineIndex 声明索引；禁止 schema.index() 与字段级 index/unique。
 * Phase 4 在此登记表之上接入真实 Mongoose 索引管理器。
 */
export interface IndexDeclaration {
  name: string;
  key: Record<string, 1 | -1>;
  options?: {
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Record<string, unknown>;
  };
  deprecated?: boolean;
}

const INDEX_REGISTRY = new Map<string, IndexDeclaration[]>();

export function defineIndex(collection: string, declaration: IndexDeclaration): IndexDeclaration {
  const entries = INDEX_REGISTRY.get(collection) ?? [];
  const duplicate = entries.find((entry) => entry.name === declaration.name);
  if (duplicate) {
    throw new ApiErrorException(
      createSkeletonError(
        { operation: `defineIndex:${collection}.${declaration.name}` },
        'registry',
      ),
    );
  }
  entries.push(declaration);
  INDEX_REGISTRY.set(collection, entries);
  return declaration;
}

export function getDeclaredIndexes(collection: string): readonly IndexDeclaration[] {
  return INDEX_REGISTRY.get(collection) ?? [];
}

export function listDeclaredIndexes(): ReadonlyMap<string, readonly IndexDeclaration[]> {
  return INDEX_REGISTRY;
}
