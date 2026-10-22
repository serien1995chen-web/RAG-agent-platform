import { createKnowledgeError } from '@kb/contracts';
import type { IndexOptions, Schema } from 'mongoose';

export interface KnowledgeIndexDeclaration {
  name: string;
  key: Record<string, 1 | -1 | 'text' | 'hashed'>;
  options?: IndexOptions & { default_language?: string };
  deprecated?: boolean;
}

const declarations = new WeakMap<Schema, KnowledgeIndexDeclaration[]>();

export function defineKnowledgeIndex(
  schema: Schema,
  declaration: KnowledgeIndexDeclaration,
): KnowledgeIndexDeclaration {
  if (declaration.name.includes('dataset')) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: 'schema-registry',
      traceId: 'schema-registry',
      details: { reason: 'legacy_index_name', index: declaration.name },
    });
  }
  schema.index(declaration.key, { ...declaration.options, name: declaration.name });
  declarations.set(schema, [...(declarations.get(schema) ?? []), declaration]);
  return declaration;
}

export function declaredKnowledgeIndexes(schema: Schema): readonly KnowledgeIndexDeclaration[] {
  return declarations.get(schema) ?? [];
}
