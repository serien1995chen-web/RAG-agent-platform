import type { Connection, Model, Schema } from 'mongoose';
import {
  CrossStoreOperationSchema,
  type CrossStoreOperationDoc,
} from './cross-store-operations.schema';
import { DatasetAclSchema, type DatasetAclDoc } from './dataset-acl.schema';
import { DatasetCollectionSchema, type DatasetCollectionDoc } from './dataset-collections.schema';
import { DatasetDataTextSchema, type DatasetDataTextDoc } from './dataset-data-texts.schema';
import { DatasetDataSchema, type DatasetDataDoc } from './dataset-datas.schema';
import {
  DatasetDeleteFailureSchema,
  type DatasetDeleteFailureDoc,
} from './dataset-delete-failures.schema';
import { DatasetDeleteJobSchema, type DatasetDeleteJobDoc } from './dataset-delete-jobs.schema';
import {
  DatasetMigrationLogSchema,
  type DatasetMigrationLogDoc,
} from './dataset-migration-logs.schema';
import { DatasetMigrationSchema, type DatasetMigrationDoc } from './dataset-migrations.schema';
import { DatasetQaTemplateSchema, type DatasetQaTemplateDoc } from './dataset-qa-templates.schema';
import { DatasetTagSchema, type DatasetTagDoc } from './dataset-tags.schema';
import { DatasetTrainingSchema, type DatasetTrainingDoc } from './dataset-trainings.schema';
import { DatasetSchema, type DatasetDoc } from './datasets.schema';
import { ImageAssetSchema, type ImageAssetDoc } from './image-assets.schema';
import { OperationLogSchema, type OperationLogDoc } from './operation-logs.schema';
import { ReconcileReportSchema, type ReconcileReportDoc } from './reconcile-reports.schema';
import { S3TtlRecordSchema, type S3TtlRecordDoc } from './s3-ttl-records.schema';
import { TrackSchema, type TrackDoc } from './tracks.schema';
import { UsageItemSchema, type UsageItemDoc } from './usage-items.schema';
import { UsageSchema, type UsageDoc } from './usages.schema';

export type { CrossStoreOperationDoc } from './cross-store-operations.schema';
export type { DatasetAclDoc } from './dataset-acl.schema';
export type { DatasetCollectionDoc } from './dataset-collections.schema';
export type { DatasetDataTextDoc } from './dataset-data-texts.schema';
export type { DatasetDataDoc } from './dataset-datas.schema';
export type { DatasetDeleteFailureDoc } from './dataset-delete-failures.schema';
export type { DatasetDeleteJobDoc } from './dataset-delete-jobs.schema';
export type { DatasetMigrationLogDoc } from './dataset-migration-logs.schema';
export type { DatasetMigrationDoc } from './dataset-migrations.schema';
export type { DatasetQaTemplateDoc } from './dataset-qa-templates.schema';
export type { DatasetTagDoc } from './dataset-tags.schema';
export type { DatasetTrainingDoc } from './dataset-trainings.schema';
export type { DatasetDoc } from './datasets.schema';
export type { ImageAssetDoc } from './image-assets.schema';
export type { OperationLogDoc } from './operation-logs.schema';
export type { ReconcileReportDoc } from './reconcile-reports.schema';
export type { S3TtlRecordDoc } from './s3-ttl-records.schema';
export type { TrackDoc } from './tracks.schema';
export type { UsageItemDoc } from './usage-items.schema';
export type { UsageDoc } from './usages.schema';
export type {
  ChunkPolicyValue,
  DataHistoryEntryValue,
  KnowledgeItemIndexValue,
  SourceRefValue,
} from './common';

export {
  CrossStoreOperationSchema,
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetDeleteFailureSchema,
  DatasetDeleteJobSchema,
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  DatasetQaTemplateSchema,
  DatasetTagSchema,
  DatasetTrainingSchema,
  DatasetSchema,
  ImageAssetSchema,
  OperationLogSchema,
  ReconcileReportSchema,
  S3TtlRecordSchema,
  TrackSchema,
  UsageItemSchema,
  UsageSchema,
};

/** 设计文档 10.2 的 20 个集合（前 8 个为 Dataset 核心集合，后 12 个为运营/迁移/审计集合）。 */
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
  {
    name: 'S3TtlRecord',
    collection: 's3_ttl_records',
    schema: S3TtlRecordSchema as unknown as Schema<unknown>,
  },
  {
    name: 'CrossStoreOperation',
    collection: 'cross_store_operations',
    schema: CrossStoreOperationSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetDeleteJob',
    collection: 'dataset_delete_jobs',
    schema: DatasetDeleteJobSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetDeleteFailure',
    collection: 'dataset_delete_failures',
    schema: DatasetDeleteFailureSchema as unknown as Schema<unknown>,
  },
  {
    name: 'ReconcileReport',
    collection: 'reconcile_reports',
    schema: ReconcileReportSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetMigration',
    collection: 'dataset_migrations',
    schema: DatasetMigrationSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetMigrationLog',
    collection: 'dataset_migration_logs',
    schema: DatasetMigrationLogSchema as unknown as Schema<unknown>,
  },
  {
    name: 'OperationLog',
    collection: 'operationLogs',
    schema: OperationLogSchema as unknown as Schema<unknown>,
  },
  {
    name: 'Usage',
    collection: 'usages',
    schema: UsageSchema as unknown as Schema<unknown>,
  },
  {
    name: 'UsageItem',
    collection: 'usage_items',
    schema: UsageItemSchema as unknown as Schema<unknown>,
  },
  {
    name: 'Track',
    collection: 'tracks',
    schema: TrackSchema as unknown as Schema<unknown>,
  },
  {
    name: 'DatasetQaTemplate',
    collection: 'dataset_qa_templates',
    schema: DatasetQaTemplateSchema as unknown as Schema<unknown>,
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
  S3TtlRecord: Model<S3TtlRecordDoc>;
  CrossStoreOperation: Model<CrossStoreOperationDoc>;
  DatasetDeleteJob: Model<DatasetDeleteJobDoc>;
  DatasetDeleteFailure: Model<DatasetDeleteFailureDoc>;
  ReconcileReport: Model<ReconcileReportDoc>;
  DatasetMigration: Model<DatasetMigrationDoc>;
  DatasetMigrationLog: Model<DatasetMigrationLogDoc>;
  OperationLog: Model<OperationLogDoc>;
  Usage: Model<UsageDoc>;
  UsageItem: Model<UsageItemDoc>;
  Track: Model<TrackDoc>;
  DatasetQaTemplate: Model<DatasetQaTemplateDoc>;
}

/** 在指定连接上注册 20 个模型；重复调用返回既有模型。 */
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
    S3TtlRecord:
      connection.models.S3TtlRecord ?? connection.model('S3TtlRecord', S3TtlRecordSchema),
    CrossStoreOperation:
      connection.models.CrossStoreOperation ??
      connection.model('CrossStoreOperation', CrossStoreOperationSchema),
    DatasetDeleteJob:
      connection.models.DatasetDeleteJob ??
      connection.model('DatasetDeleteJob', DatasetDeleteJobSchema),
    DatasetDeleteFailure:
      connection.models.DatasetDeleteFailure ??
      connection.model('DatasetDeleteFailure', DatasetDeleteFailureSchema),
    ReconcileReport:
      connection.models.ReconcileReport ??
      connection.model('ReconcileReport', ReconcileReportSchema),
    DatasetMigration:
      connection.models.DatasetMigration ??
      connection.model('DatasetMigration', DatasetMigrationSchema),
    DatasetMigrationLog:
      connection.models.DatasetMigrationLog ??
      connection.model('DatasetMigrationLog', DatasetMigrationLogSchema),
    OperationLog:
      connection.models.OperationLog ?? connection.model('OperationLog', OperationLogSchema),
    Usage: connection.models.Usage ?? connection.model('Usage', UsageSchema),
    UsageItem: connection.models.UsageItem ?? connection.model('UsageItem', UsageItemSchema),
    Track: connection.models.Track ?? connection.model('Track', TrackSchema),
    DatasetQaTemplate:
      connection.models.DatasetQaTemplate ??
      connection.model('DatasetQaTemplate', DatasetQaTemplateSchema),
  } as RegisteredModels;
}
