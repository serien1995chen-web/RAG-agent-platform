/**
 * persistence 子树出口（P2-02）：只导出当时已存在的 define-index、schemas 与索引管理器。
 * P2-03/04/05 的新能力通过各自子目录出口与直接模块路径消费，不回改本文件。
 */
export {
  collectionNameOf,
  defineIndex,
  getDeclaredIndexes,
  listDeclaredIndexes,
} from './define-index';
export type { IndexDeclaration } from './define-index';

export { MongoIndexManager } from './mongo-index-manager';

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
  MONGO_SCHEMA_REGISTRY,
  OperationLogSchema,
  ReconcileReportSchema,
  S3TtlRecordSchema,
  TrackSchema,
  UsageItemSchema,
  UsageSchema,
  registerMongoModels,
} from './schemas';
export type {
  ChunkPolicyValue,
  CrossStoreOperationDoc,
  DataHistoryEntryValue,
  DatasetAclDoc,
  DatasetCollectionDoc,
  DatasetDataDoc,
  DatasetDataTextDoc,
  DatasetDeleteFailureDoc,
  DatasetDeleteJobDoc,
  DatasetDoc,
  DatasetMigrationDoc,
  DatasetMigrationLogDoc,
  DatasetQaTemplateDoc,
  DatasetTagDoc,
  DatasetTrainingDoc,
  ImageAssetDoc,
  KnowledgeItemIndexValue,
  OperationLogDoc,
  ReconcileReportDoc,
  RegisteredModels,
  S3TtlRecordDoc,
  SourceRefValue,
  TrackDoc,
  UsageDoc,
  UsageItemDoc,
} from './schemas';
