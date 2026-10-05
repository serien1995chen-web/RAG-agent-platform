/**
 * @kb/storage — S3 兼容对象存储适配（CR-REF-06，设计文档 7.6 / 10.9.1）。
 * 显式导出面，禁止 export *。
 */
export const PACKAGE_NAME = '@kb/storage' as const;

export { MinioObjectStore } from './adapters/minio-object-store';
export type { MinioObjectStoreConfig } from './adapters/minio-object-store';
export { createObjectStore } from './factory';
export type { ObjectStoreConfig } from './factory';
export type { ObjectRef, ObjectStorePort, TenantObjectContext } from './interface';
export { OBJECT_KEY_PREFIXES, assertObjectKeyScope, objectKeyHash } from './tenant-scope';
