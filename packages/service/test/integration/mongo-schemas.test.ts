import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatasetDataSchema,
  DatasetSchema,
  DatasetTrainingSchema,
  MONGO_SCHEMA_REGISTRY,
  registerMongoModels,
  type RegisteredModels,
} from '../../src/index';

const uri = process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_integration';

let connection: mongoose.Connection;
let models: RegisteredModels;

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

describe('Mongo schemas (10.3-10.10)', () => {
  it('creates exactly the eight registered collections', async () => {
    const collections = (await connection.db!.listCollections().toArray())
      .map((item) => item.name)
      .sort();
    expect(collections).toEqual(
      [
        'dataset_acl',
        'dataset_collections',
        'dataset_data_texts',
        'dataset_datas',
        'dataset_tags',
        'dataset_trainings',
        'datasets',
        'image_assets',
      ].sort(),
    );
  });

  it('declares at least one defineIndex index per schema', () => {
    for (const entry of MONGO_SCHEMA_REGISTRY) {
      expect(entry.schema.indexes().length, entry.collection).toBeGreaterThan(0);
    }
  });

  it('keeps the frozen unique and partial indexes on the schemas', () => {
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
