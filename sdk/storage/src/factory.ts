import { MinioObjectStore, type MinioObjectStoreConfig } from './adapters/minio-object-store';
import type { ObjectStorePort } from './interface';

export type ObjectStoreConfig = MinioObjectStoreConfig;

export function createObjectStore(config: ObjectStoreConfig): ObjectStorePort {
  return new MinioObjectStore(config);
}
