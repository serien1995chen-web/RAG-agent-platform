import { ApiErrorException, createInternalError } from '@kb/contracts';
import type { Connection, Schema } from 'mongoose';
import type { IndexDiff, MongoIndexManagerPort } from '../../ports/capabilities';
import type { RequestContext } from '../../ports/types';
import { validateTenantContext } from '../../ports/types';
import { collectionNameOf, listDeclaredIndexes, type IndexDeclaration } from './define-index';
import { MONGO_SCHEMA_REGISTRY } from './schemas';

interface ActualIndex {
  name: string;
  key: Record<string, unknown>;
  weights?: Record<string, unknown>;
}

type DbCollection = ReturnType<NonNullable<Connection['db']>['collection']>;
type IndexSpec = Parameters<DbCollection['createIndexes']>[0][number];

/**
 * 声明键与真实索引键的一致性比较。
 * Mongo 文本索引把文本字段放在 weights，并在 key 中返回 _fts/_ftsx 内部字段；
 * 非文本索引要求字段集与方向完全一致，避免把同名不同键误判为匹配。
 */
function keyMatches(
  actual: Record<string, unknown>,
  declared: Record<string, unknown>,
  weights?: Record<string, unknown>,
): boolean {
  const declaredText = Object.entries(declared).filter(([, direction]) => direction === 'text');
  const actualFields = Object.keys(actual).filter((field) => field !== '_fts' && field !== '_ftsx');

  if (declaredText.length === 0) {
    return (
      actualFields.length === Object.keys(declared).length &&
      Object.entries(declared).every(
        ([field, direction]) =>
          actualFields.includes(field) && String(actual[field]) === String(direction),
      )
    );
  }

  if (actual['_fts'] !== 'text') return false;
  const declaredPlain = Object.entries(declared).filter(([, direction]) => direction !== 'text');
  if (actualFields.length !== declaredPlain.length) return false;
  const plainMatches = declaredPlain.every(
    ([field, direction]) =>
      actualFields.includes(field) && String(actual[field]) === String(direction),
  );
  const textMatches = declaredText.every(([field]) => typeof weights?.[field] === 'number');
  return plainMatches && textMatches;
}

function isNamespaceMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; codeName?: unknown };
  return record.code === 26 || record.codeName === 'NamespaceNotFound';
}

/**
 * 索引声明同步与清理管理器（设计文档 17.3 / 18.8，PORT-INDEX-001）。
 * 只补建缺失的登记索引；未登记、同名不同键的客户索引只报告不删除；
 * cleanup 仅在调用方显式传入 deprecated 名称且声明 deprecated=true 时删除。
 */
export class MongoIndexManager implements MongoIndexManagerPort {
  constructor(private readonly connection: Connection) {}

  private assertTenant(context: RequestContext): void {
    const result = validateTenantContext(context.tenant, context.requestId);
    if (!result.ok) throw new ApiErrorException(result.error);
  }

  private requireDb(context: RequestContext) {
    if (!this.connection.db) {
      throw new ApiErrorException(
        createInternalError('mongo-index-manager:connection', context.requestId),
      );
    }
    return this.connection.db;
  }

  private schemaFor(collection: string): Schema<unknown> | undefined {
    const registered = MONGO_SCHEMA_REGISTRY.find((entry) => entry.collection === collection);
    if (registered) return registered.schema;
    for (const schema of listDeclaredIndexes().keys()) {
      if (collectionNameOf(schema) === collection) return schema;
    }
    return undefined;
  }

  private declarationsFor(schema: Schema<unknown>): readonly IndexDeclaration[] {
    return listDeclaredIndexes().get(schema) ?? [];
  }

  private async actualIndexes(collection: string): Promise<ActualIndex[]> {
    const db = this.connection.db;
    if (!db) return [];
    try {
      const indexes = await db.collection(collection).indexes();
      return indexes.map((index) => ({
        name: String(index.name ?? ''),
        key: (index.key ?? {}) as Record<string, unknown>,
        ...(typeof index.weights === 'object' && index.weights !== null
          ? { weights: index.weights as Record<string, unknown> }
          : {}),
      }));
    } catch (error) {
      if (isNamespaceMissing(error)) return [];
      throw error;
    }
  }

  async inspect(
    input: { collection: string; dryRun: boolean; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<IndexDiff> {
    this.assertTenant(context);
    const schema = this.schemaFor(input.collection);
    if (!schema) {
      return {
        created: [],
        dropped: [],
        skipped: [],
        errors: [`unknown_collection:${input.collection}`],
      };
    }
    const declarations = this.declarationsFor(schema);
    const actual = await this.actualIndexes(input.collection);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const declaration of declarations) {
      const existing = actual.find((index) => index.name === declaration.name);
      if (!existing) {
        created.push(declaration.name);
        continue;
      }
      if (keyMatches(existing.key, declaration.key, existing.weights)) {
        skipped.push(`matched:${declaration.name}`);
      } else {
        errors.push(`key_mismatch:${declaration.name}`);
      }
    }

    for (const index of actual) {
      if (index.name === '_id_') continue;
      if (!declarations.some((declaration) => declaration.name === index.name)) {
        skipped.push(`unregistered:${index.name}`);
      }
    }

    return { created, dropped: [], skipped, errors };
  }

  async sync(
    input: { collection: string; dryRun: boolean; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<IndexDiff> {
    this.assertTenant(context);
    const diff = await this.inspect(input, context);
    if (input.dryRun || diff.errors.length > 0 || diff.created.length === 0) return diff;

    const schema = this.schemaFor(input.collection);
    if (!schema) return diff;
    const declarations = this.declarationsFor(schema);
    const db = this.requireDb(context);
    const created: string[] = [];
    const errors = [...diff.errors];

    for (const name of diff.created) {
      const declaration = declarations.find((entry) => entry.name === name);
      if (!declaration) continue;
      try {
        const spec = {
          key: declaration.key,
          name: declaration.name,
          ...(declaration.options ?? {}),
        } as unknown as IndexSpec;
        await db.collection(input.collection).createIndexes([spec]);
        created.push(name);
      } catch {
        errors.push(`create_failed:${name}`);
        break;
      }
    }

    return { created, dropped: [], skipped: diff.skipped, errors };
  }

  async cleanup(
    input: {
      collection: string;
      deprecatedNames: string[];
      dryRun: boolean;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ dropped: string[]; skipped: string[] }> {
    this.assertTenant(context);
    const dropped: string[] = [];
    const skipped: string[] = [];
    if (input.deprecatedNames.length === 0) return { dropped, skipped };

    const schema = this.schemaFor(input.collection);
    if (!schema) return { dropped, skipped: [`unknown_collection:${input.collection}`] };

    const declarations = this.declarationsFor(schema);
    const actual = await this.actualIndexes(input.collection);
    const db = this.requireDb(context);

    for (const name of input.deprecatedNames) {
      const declaration = declarations.find((entry) => entry.name === name);
      if (!declaration || declaration.deprecated !== true) {
        skipped.push(`not_deprecated:${name}`);
        continue;
      }
      const existing = actual.find((index) => index.name === name);
      if (!existing) {
        skipped.push(`missing:${name}`);
        continue;
      }
      if (!keyMatches(existing.key, declaration.key, existing.weights)) {
        skipped.push(`key_mismatch:${name}`);
        continue;
      }
      if (input.dryRun) {
        skipped.push(`would_drop:${name}`);
        continue;
      }
      try {
        await db.collection(input.collection).dropIndex(name);
        dropped.push(name);
      } catch {
        skipped.push(`drop_failed:${name}`);
      }
    }

    return { dropped, skipped };
  }
}
