import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MONGO_SCHEMA_REGISTRY,
  MongoIndexManager,
  defineIndex,
  getDeclaredIndexes,
} from '../../src/shared/persistence';
import type { RequestContext } from '../../src/index';

const uri = process.env.KB_TEST_MONGO_INDEX_URI ?? 'mongodb://127.0.0.1:27017/kb_index_manager_it';

const options = { timeoutMs: 5000 };
const context: RequestContext = {
  requestId: 'req-index-manager',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

let connection: mongoose.Connection;
let manager: MongoIndexManager;

async function indexNames(collection: string): Promise<string[]> {
  return (await connection.db!.collection(collection).indexes()).map((index) => index.name);
}

beforeAll(async () => {
  connection = mongoose.createConnection(uri);
  await connection.asPromise();
  await connection.dropDatabase();
  manager = new MongoIndexManager(connection);
});

afterAll(async () => {
  await connection.dropDatabase();
  await connection.close();
});

describe('MongoIndexManager (17.3 / PORT-INDEX-001)', () => {
  it('creates every declared index on an empty database and stays idempotent', async () => {
    let totalCreated = 0;
    for (const entry of MONGO_SCHEMA_REGISTRY) {
      const diff = await manager.sync(
        { collection: entry.collection, dryRun: false, options },
        context,
      );
      expect(diff.errors, entry.collection).toEqual([]);
      totalCreated += diff.created.length;
    }
    expect(totalCreated).toBeGreaterThanOrEqual(40);

    for (const entry of MONGO_SCHEMA_REGISTRY) {
      const actual = await indexNames(entry.collection);
      for (const declaration of getDeclaredIndexes(entry.schema)) {
        expect(actual, `${entry.collection}:${declaration.name}`).toContain(declaration.name);
      }
    }

    for (const entry of MONGO_SCHEMA_REGISTRY) {
      const again = await manager.sync(
        { collection: entry.collection, dryRun: false, options },
        context,
      );
      expect(again.created, entry.collection).toEqual([]);
      expect(again.errors, entry.collection).toEqual([]);
    }
  });

  it('keeps customer-created indexes and validates the tenant context', async () => {
    await connection
      .db!.collection('datasets')
      .createIndex({ customerField: 1 }, { name: 'customer_custom_idx' });

    const diff = await manager.sync({ collection: 'datasets', dryRun: false, options }, context);
    expect(diff.dropped).toEqual([]);
    expect(diff.skipped).toContain('unregistered:customer_custom_idx');
    expect(await indexNames('datasets')).toContain('customer_custom_idx');

    await expect(
      manager.inspect(
        { collection: 'datasets', dryRun: true, options },
        { ...context, tenant: { ...context.tenant, teamId: '' } },
      ),
    ).rejects.toMatchObject({ error: { code: 501012 } });

    const unknown = await manager.inspect(
      { collection: 'not_registered', dryRun: true, options },
      context,
    );
    expect(unknown.errors).toContain('unknown_collection:not_registered');
  });

  it('never drops indexes through the default cleanup path', async () => {
    const empty = await manager.cleanup(
      { collection: 'datasets', deprecatedNames: [], dryRun: false, options },
      context,
    );
    expect(empty).toEqual({ dropped: [], skipped: [] });

    const notDeprecated = await manager.cleanup(
      {
        collection: 'datasets',
        deprecatedNames: ['ds_datasets_team_parent_idx'],
        dryRun: false,
        options,
      },
      context,
    );
    expect(notDeprecated.dropped).toEqual([]);
    expect(notDeprecated.skipped).toContain('not_deprecated:ds_datasets_team_parent_idx');
    expect(await indexNames('datasets')).toContain('ds_datasets_team_parent_idx');
  });

  it('blocks same-name-different-key cleanup and only drops explicit deprecated indexes', async () => {
    const cleanupSchema = new mongoose.Schema(
      { a: Number, b: Number },
      { collection: 'index_manager_cleanup_it', versionKey: false },
    );
    defineIndex(cleanupSchema, {
      name: 'im_cleanup_deprecated_idx',
      key: { a: 1 },
      deprecated: true,
    });

    const collection = connection.db!.collection('index_manager_cleanup_it');
    await collection.createIndex({ b: 1 }, { name: 'im_cleanup_deprecated_idx' });

    const mismatch = await manager.cleanup(
      {
        collection: 'index_manager_cleanup_it',
        deprecatedNames: ['im_cleanup_deprecated_idx'],
        dryRun: false,
        options,
      },
      context,
    );
    expect(mismatch.dropped).toEqual([]);
    expect(mismatch.skipped).toContain('key_mismatch:im_cleanup_deprecated_idx');
    expect((await collection.indexes()).map((index) => index.name)).toContain(
      'im_cleanup_deprecated_idx',
    );

    await collection.dropIndex('im_cleanup_deprecated_idx');
    await collection.createIndex({ a: 1 }, { name: 'im_cleanup_deprecated_idx' });

    const dryRun = await manager.cleanup(
      {
        collection: 'index_manager_cleanup_it',
        deprecatedNames: ['im_cleanup_deprecated_idx'],
        dryRun: true,
        options,
      },
      context,
    );
    expect(dryRun.dropped).toEqual([]);
    expect(dryRun.skipped).toContain('would_drop:im_cleanup_deprecated_idx');
    expect((await collection.indexes()).map((index) => index.name)).toContain(
      'im_cleanup_deprecated_idx',
    );

    const dropped = await manager.cleanup(
      {
        collection: 'index_manager_cleanup_it',
        deprecatedNames: ['im_cleanup_deprecated_idx'],
        dryRun: false,
        options,
      },
      context,
    );
    expect(dropped.dropped).toEqual(['im_cleanup_deprecated_idx']);
    expect((await collection.indexes()).map((index) => index.name)).not.toContain(
      'im_cleanup_deprecated_idx',
    );
  });
});
