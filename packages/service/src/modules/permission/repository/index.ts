import { createUnimplementedPort } from '../../../ports/defaults';
import type { DatasetPermissionPort } from '../../../ports/capabilities';
import type { Connection } from 'mongoose';
import { MongoDatasetAclRepository } from './mongo-dataset-acl.repository';

export function createDatasetAclRepository(connection?: Connection): DatasetPermissionPort {
  if (connection) return new MongoDatasetAclRepository(connection);
  return createUnimplementedPort<DatasetPermissionPort>('DatasetPermissionPort');
}
