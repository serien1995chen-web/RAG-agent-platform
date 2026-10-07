import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CrossStoreOperationSchema,
  DatasetDataSchema,
  DatasetDeleteFailureSchema,
  DatasetDeleteJobSchema,
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  DatasetQaTemplateSchema,
  DatasetSchema,
  DatasetTrainingSchema,
  MONGO_SCHEMA_REGISTRY,
  ReconcileReportSchema,
  S3TtlRecordSchema,
  UsageItemSchema,
  UsageSchema,
  registerMongoModels,
  type RegisteredModels,
} from '../../src/shared/persistence/schemas';

const uri = process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_integration';

const expectedCollections = [
  'cross_store_operations',
  'dataset_acl',
  'dataset_collections',
  'dataset_data_texts',
  'dataset_datas',
  'dataset_delete_failures',
  'dataset_delete_jobs',
  'dataset_migration_logs',
  'dataset_migrations',
  'dataset_qa_templates',
  'dataset_tags',
  'dataset_trainings',
  'datasets',
  'image_assets',
  'operationLogs',
  'reconcile_reports',
  's3_ttl_records',
  'tracks',
  'usage_items',
  'usages',
];

let connection: mongoose.Connection;
let models: RegisteredModels;

function indexOptions(schema: mongoose.Schema<unknown>, name: string) {
  return schema.indexes().find(([, options]) => options?.name === name)?.[1];
}

beforeAll(async () => {
  connection = mongoose.createConnection(uri);
  await connection.asPromise();
  await connection.dropDatabase();
  models = registerMongoModels(connection);
  await Promise.all(Object.values(models).map((model) => model.init()));
});

afterAll(async () => {
  await connection.dropDatabase();
  await connection.close();
});

describe('Mongo schemas (10.2-10.15)', () => {
  it('creates exactly the twenty registered collections', async () => {
    const collections = (await connection.db!.listCollections().toArray())
      .map((item) => item.name)
      .sort();
    expect(collections).toEqual([...expectedCollections].sort());
  });

  it('registers twenty unique collections and keeps one index per schema', () => {
    expect(MONGO_SCHEMA_REGISTRY).toHaveLength(20);
    expect(new Set(MONGO_SCHEMA_REGISTRY.map((entry) => entry.collection)).size).toBe(20);
    for (const entry of MONGO_SCHEMA_REGISTRY) {
      expect(entry.schema.indexes().length, entry.collection).toBeGreaterThan(0);
    }
  });

  it('keeps the frozen indexes on the existing dataset schemas', () => {
    const datasetIndex = DatasetSchema.indexes().find(
      ([, options]) => options?.name === 'ds_datasets_team_parent_idx',
    );
    expect(datasetIndex).toBeDefined();

    const dedup = DatasetDataSchema.indexes().find(
      ([, options]) => options?.name === 'ds_dataset_datas_team_dedup_unique',
    );
    expect(dedup?.[1]?.unique).toBe(true);
    expect(dedup?.[1]?.partialFilterExpression).toMatchObject({
      dedupKey: { $type: 'string' },
    });

    const ttl = DatasetTrainingSchema.indexes().find(
      ([, options]) => options?.name === 'ds_dataset_trainings_expire_ttl_idx',
    );
    expect(ttl?.[1]?.expireAfterSeconds).toBe(604800);
  });

  it('declares the operational unique, partial and TTL indexes', () => {
    expect(indexOptions(S3TtlRecordSchema, 'ds_s3_ttl_records_bucket_object_unique')?.unique).toBe(
      true,
    );
    expect(indexOptions(S3TtlRecordSchema, 'ds_s3_ttl_records_operation_unique')?.unique).toBe(
      true,
    );
    expect(
      S3TtlRecordSchema.indexes().some(([, options]) => options?.expireAfterSeconds !== undefined),
    ).toBe(false);

    expect(
      indexOptions(DatasetDeleteJobSchema, 'ds_dataset_delete_jobs_team_job_unique')?.unique,
    ).toBe(true);
    expect(
      indexOptions(DatasetDeleteFailureSchema, 'ds_dataset_delete_failures_resource_idx'),
    ).toBeDefined();

    expect(
      indexOptions(CrossStoreOperationSchema, 'ds_cross_store_operations_team_operation_unique')
        ?.unique,
    ).toBe(true);
    expect(indexOptions(ReconcileReportSchema, 'ds_reconcile_reports_dedup_unique')?.unique).toBe(
      true,
    );

    expect(
      indexOptions(DatasetMigrationSchema, 'ds_dataset_migrations_version_unique')?.unique,
    ).toBe(true);
    expect(
      indexOptions(DatasetMigrationSchema, 'ds_dataset_migrations_scope_running_unique'),
    ).toMatchObject({ unique: true, partialFilterExpression: { state: 'running' } });
    expect(
      indexOptions(DatasetMigrationLogSchema, 'ds_dataset_migration_logs_migration_data_unique'),
    ).toMatchObject({ unique: true, partialFilterExpression: { dataId: { $type: 'string' } } });

    expect(indexOptions(UsageSchema, 'ds_usages_time_ttl_idx')?.expireAfterSeconds).toBe(31104000);
    expect(indexOptions(UsageItemSchema, 'ds_usage_items_time_ttl_idx')?.expireAfterSeconds).toBe(
      31104000,
    );
    expect(indexOptions(UsageItemSchema, 'ds_usage_items_team_dedup_unique')).toMatchObject({
      unique: true,
      partialFilterExpression: { dedupKey: { $type: 'string' } },
    });
    expect(
      indexOptions(
        DatasetQaTemplateSchema,
        'ds_dataset_qa_templates_template_version_locale_unique',
      )?.unique,
    ).toBe(true);
  });

  it('keeps registerMongoModels idempotent for the expanded registry', () => {
    const again = registerMongoModels(connection);
    expect(again.Dataset).toBe(models.Dataset);
    expect(again.Usage).toBe(models.Usage);
    expect(Object.keys(again)).toHaveLength(20);
  });

  it('rejects websiteDataset and the auto training mode at schema level', async () => {
    await expect(
      models.Dataset.create({
        teamId: new mongoose.Types.ObjectId(),
        createdBy: new mongoose.Types.ObjectId(),
        type: 'websiteDataset',
        name: 'nope',
        vectorModel: 'bge-m3',
        indexVersion: 'bge-m3:1536:v1',
      }),
    ).rejects.toBeDefined();

    await expect(
      models.DatasetTraining.create({
        teamId: new mongoose.Types.ObjectId(),
        datasetId: new mongoose.Types.ObjectId(),
        collectionId: new mongoose.Types.ObjectId(),
        mode: 'auto',
        expireAt: new Date(),
      }),
    ).rejects.toBeDefined();
  });
});
