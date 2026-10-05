import type { Connection, Model, Schema } from 'mongoose';
import { DatasetAclSchema, type DatasetAclDoc } from './dataset-acl.schema';
import { DatasetCollectionSchema, type DatasetCollectionDoc } from './dataset-collections.schema';
import { DatasetDataTextSchema, type DatasetDataTextDoc } from './dataset-data-texts.schema';
import { DatasetDataSchema, type DatasetDataDoc } from './dataset-datas.schema';
import { DatasetTagSchema, type DatasetTagDoc } from './dataset-tags.schema';
import { DatasetTrainingSchema, type DatasetTrainingDoc } from './dataset-trainings.schema';
import { DatasetSchema, type DatasetDoc } from './datasets.schema';
import { ImageAssetSchema, type ImageAssetDoc } from './image-assets.schema';

export type { DatasetAclDoc } from './dataset-acl.schema';
export type { DatasetCollectionDoc } from './dataset-collections.schema';
export type { DatasetDataTextDoc } from './dataset-data-texts.schema';
export type { DatasetDataDoc } from './dataset-datas.schema';
export type { DatasetTagDoc } from './dataset-tags.schema';
export type { DatasetTrainingDoc } from './dataset-trainings.schema';
export type { DatasetDoc } from './datasets.schema';
export type { ImageAssetDoc } from './image-assets.schema';
export type {
  ChunkPolicyValue,
  DataHistoryEntryValue,
  KnowledgeItemIndexValue,
  SourceRefValue,
} from './common';

export {
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetTagSchema,
  DatasetTrainingSchema,
  DatasetSchema,
  ImageAssetSchema,
};

/** 设计文档 10.3-10.10 的 8 个 Dataset 集合。 */
export const MONGO_SCHEMA_REGISTRY: readonly {
  name: string;
  collection: string;
  schema: Schema<unknown>;
}[] = [
  { name: 'Dataset', collection: 'datasets', schema: DatasetSchema as unknown as Schema<unknown> },
  {
    name: 'DatasetCollection',
    collection: 'dataset_collections',
    schema: DatasetCollectionSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetData',
    collection: 'dataset_datas',
    schema: DatasetDataSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetDataText',
    collection: 'dataset_data_texts',
    schema: DatasetDataTextSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetTraining',
    collection: 'dataset_trainings',
    schema: DatasetTrainingSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetTag',
    collection: 'dataset_tags',
    schema: DatasetTagSchema as unknown as Schema<unknown>,
  },
  {
    name: 'ImageAsset',
    collection: 'image_assets',
    schema: ImageAssetSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetAcl',
    collection: 'dataset_acl',
    schema: DatasetAclSchema as unknown as Schema<unknown>,
  },
];

export interface RegisteredModels {
  Dataset: Model<DatasetDoc>;
  DatasetCollection: Model<DatasetCollectionDoc>;
  DatasetData: Model<DatasetDataDoc>;
  DatasetDataText: Model<DatasetDataTextDoc>;
  DatasetTraining: Model<DatasetTrainingDoc>;
  DatasetTag: Model<DatasetTagDoc>;
  ImageAsset: Model<ImageAssetDoc>;
  DatasetAcl: Model<DatasetAclDoc>;
}

/** 在指定连接上注册 8 个模型；重复调用返回既有模型。 */
export function registerMongoModels(connection: Connection): RegisteredModels {
  return {
    Dataset: connection.models.Dataset ?? connection.model('Dataset', DatasetSchema),
    DatasetCollection:
      connection.models.DatasetCollection ??
      connection.model('DatasetCollection', DatasetCollectionSchema),
    DatasetData:
      connection.models.DatasetData ?? connection.model('DatasetData', DatasetDataSchema),
    DatasetDataText:
      connection.models.DatasetDataText ??
      connection.model('DatasetDataText', DatasetDataTextSchema),
    DatasetTraining:
      connection.models.DatasetTraining ??
      connection.model('DatasetTraining', DatasetTrainingSchema),
    DatasetTag: connection.models.DatasetTag ?? connection.model('DatasetTag', DatasetTagSchema),
    ImageAsset: connection.models.ImageAsset ?? connection.model('ImageAsset', ImageAssetSchema),
    DatasetAcl: connection.models.DatasetAcl ?? connection.model('DatasetAcl', DatasetAclSchema),
  } as RegisteredModels;
}
